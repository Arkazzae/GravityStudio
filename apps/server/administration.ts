import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AdminUser, Invitation, PublicInvitation, UserRole } from "../../packages/contracts/admin.ts";
import { ApiError, type Owner } from "../../packages/contracts/index.ts";
import { digest, hashPassword, validateCredentials } from "./auth.ts";
import type { Store } from "./store.ts";
import { deleteInput, deleteOutput } from "./media.ts";
import { WorkTimeService } from "./work-time.ts";

const at = () => new Date().toISOString();
const userColumns = "id,username,email,role,status,created_at AS createdAt,revision";
const invitationColumns = "id,email,role,created_at AS createdAt,expires_at AS expiresAt,created_by AS createdBy,status,accepted_by AS acceptedBy,initial_time_ms AS initialTimeMs,delivery";
function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = run(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function initializeAdministration(db: DatabaseSync) {
  transaction(db, () => {
    const columns = new Set((db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map(column => column.name));
    for (const [name, definition] of Object.entries({ role: "TEXT NOT NULL DEFAULT 'user'", status: "TEXT NOT NULL DEFAULT 'active'", email: "TEXT", revision: "INTEGER NOT NULL DEFAULT 0" })) {
      if (!columns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
    }
    if (!db.prepare("SELECT 1 FROM metadata WHERE key='administration-version'").get()) {
      const first = db.prepare("SELECT id FROM users ORDER BY created_at,id LIMIT 1").get() as { id: string } | undefined;
      if (first) {
        db.prepare("UPDATE users SET role='admin' WHERE id=?").run(first.id);
        db.prepare("INSERT OR IGNORE INTO metadata VALUES('owner-id',?)").run(JSON.stringify(first.id));
      }
      db.prepare("INSERT INTO metadata VALUES('administration-version','1')").run();
    }
    db.exec(`CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, email TEXT, role TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending', accepted_by TEXT REFERENCES users(id),
      initial_time_ms INTEGER NOT NULL, delivery TEXT NOT NULL DEFAULT 'not_sent');
      CREATE TABLE IF NOT EXISTS admin_audit (
      id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), target_id TEXT NOT NULL,
      action TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS invitations_status ON invitations(status,expires_at);`);
  });
}
export function requireActiveUser(db: DatabaseSync, userId: string): Owner {
  const user = db.prepare("SELECT id,username,role FROM users WHERE id=? AND status='active'").get(userId) as Owner | undefined;
  if (!user) throw new ApiError(403, "ACCOUNT_INACTIVE", "This account is no longer active. Contact your administrator.");
  return user;
}
export function requireAdministrator(db: DatabaseSync, userId: string): Owner {
  const user = requireActiveUser(db, userId);
  if (user.role !== "admin") throw new ApiError(403, "ADMIN_REQUIRED", "Administrator access is required.");
  return user;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "INVALID_ADMIN_REQUEST", "Supply the requested fields as an object.");
  return value as Record<string, unknown>;
}
function fields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new ApiError(400, "INVALID_ADMIN_REQUEST", "This request contains unsupported fields.");
}
function role(value: unknown): UserRole {
  if (value !== "admin" && value !== "user") throw new ApiError(400, "INVALID_ROLE", "Choose administrator or user.");
  return value;
}
function email(value: unknown): string | null {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 254 || !/^[^\s<>@\x00-\x1f\x7f]+@[^\s<>@\x00-\x1f\x7f]+\.[^\s<>@\x00-\x1f\x7f]+$/.test(value)) throw new ApiError(400, "INVALID_EMAIL", "Enter a valid email address.");
  return value.toLowerCase();
}
function invitation(row: Invitation): Invitation {
  return { ...row, status: row.status === "pending" && Date.parse(row.expiresAt) <= Date.now() ? "expired" : row.status };
}
export class Administration {
  private store: Store;
  private workTime: WorkTimeService;
  private deletions = new Map<string, Promise<void>>();
  constructor(store: Store, workTime: WorkTimeService) { this.store = store; this.workTime = workTime; }
  users(): AdminUser[] { return this.store.db.prepare(`SELECT ${userColumns} FROM users WHERE status!='deleted' ORDER BY created_at,id`).all() as unknown as AdminUser[]; }
  user(id: string): AdminUser {
    const user = this.store.db.prepare(`SELECT ${userColumns} FROM users WHERE id=? AND status!='deleted'`).get(id) as AdminUser | undefined;
    if (!user) throw new ApiError(404, "USER_NOT_FOUND", "This account does not exist.");
    return { ...user };
  }
  private audit(actor: string, target: string, action: string, details: unknown) {
    this.store.db.prepare("INSERT INTO admin_audit VALUES(?,?,?,?,?,?)").run(randomUUID(), actor, target, action, JSON.stringify(details), at());
  }
  private mutable(actor: string, id: string, revision: unknown): AdminUser {
    requireAdministrator(this.store.db, actor);
    const user = this.user(id);
    if (user.revision !== revision) throw new ApiError(409, "USER_CHANGED", "This account changed in another window. Reload before continuing.");
    if (actor === id) throw new ApiError(409, "OWN_ACCOUNT_PROTECTED", "Ask another administrator to change or remove your administrator account.");
    if (user.role === "admin" && user.status === "active") {
      const count = this.store.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND status='active'").get() as { count: number };
      if (count.count <= 1) throw new ApiError(409, "LAST_ADMIN", "Keep at least one active administrator.");
    }
    return user;
  }
  private revokeAccess(id: string) {
    this.store.db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
    this.store.db.prepare("DELETE FROM api_tokens WHERE user_id=?").run(id);
    this.store.db.prepare("UPDATE invitations SET status='revoked' WHERE created_by=? AND status='pending'").run(id);
  }
  update(actor: string, id: string, value: unknown): AdminUser {
    const body = object(value); fields(body, ["revision", "role", "status"]);
    const nextRole = role(body.role);
    if (body.status !== "active" && body.status !== "suspended") throw new ApiError(400, "INVALID_USER_STATUS", "Choose active or suspended.");
    return transaction(this.store.db, () => {
      const user = this.mutable(actor, id, body.revision);
      if (user.status === "deleting") throw new ApiError(409, "USER_DELETION_PENDING", "This account is being deleted.");
      if (nextRole !== user.role || body.status !== "active") this.revokeAccess(id);
      this.store.db.prepare("UPDATE users SET role=?,status=?,revision=revision+1 WHERE id=?").run(nextRole, body.status as string, id);
      this.audit(actor, id, "user.updated", { role: nextRole, status: body.status });
      return this.user(id);
    });
  }
  invitations(): Invitation[] { return (this.store.db.prepare(`SELECT ${invitationColumns} FROM invitations ORDER BY created_at DESC LIMIT 500`).all() as unknown as Invitation[]).map(invitation); }
  private invitation(id: string): Invitation {
    const row = this.store.db.prepare(`SELECT ${invitationColumns} FROM invitations WHERE id=?`).get(id) as Invitation | undefined;
    if (!row) throw new ApiError(404, "INVITATION_NOT_FOUND", "This invitation does not exist.");
    return invitation(row);
  }
  createInvitation(actor: string, value: unknown): { invitation: Invitation; token: string; sendEmail: boolean } {
    const body = object(value); fields(body, ["email", "role", "expiresInHours", "initialTimeMs", "sendEmail"]);
    const to = email(body.email), inviteRole = role(body.role);
    if (!Number.isInteger(body.expiresInHours) || (body.expiresInHours as number) < 1 || (body.expiresInHours as number) > 720) throw new ApiError(400, "INVALID_INVITATION_EXPIRY", "Choose an invitation lifetime between 1 and 720 hours.");
    if (!Number.isSafeInteger(body.initialTimeMs) || (body.initialTimeMs as number) < 0 || (body.initialTimeMs as number) > 31_536_000_000) throw new ApiError(400, "INVALID_TIME_GRANT", "Choose an initial time allowance between zero and one year.");
    if (typeof body.sendEmail !== "boolean" || (body.sendEmail && !to)) throw new ApiError(400, "INVITATION_EMAIL_REQUIRED", "Enter an email address to send this invitation.");
    return transaction(this.store.db, () => {
      requireAdministrator(this.store.db, actor);
      const token = randomBytes(32).toString("base64url"), id = randomUUID();
      this.store.db.prepare("INSERT INTO invitations(id,token_hash,email,role,created_at,expires_at,created_by,initial_time_ms) VALUES(?,?,?,?,?,?,?,?)").run(id, digest(token), to, inviteRole, at(), new Date(Date.now() + (body.expiresInHours as number) * 3_600_000).toISOString(), actor, body.initialTimeMs as number);
      this.audit(actor, id, "invitation.created", { role: inviteRole, initialTimeMs: body.initialTimeMs });
      return { invitation: this.invitation(id), token, sendEmail: body.sendEmail as boolean };
    });
  }
  delivery(id: string, state: "sent" | "failed"): Invitation {
    this.store.db.prepare("UPDATE invitations SET delivery=? WHERE id=?").run(state, id);
    return this.invitation(id);
  }
  revokeInvitation(actor: string, id: string) {
    transaction(this.store.db, () => {
      requireAdministrator(this.store.db, actor);
      const current = this.invitation(id);
      if (current.status === "accepted") throw new ApiError(409, "INVITATION_ACCEPTED", "This invitation has already been used. Manage the user account instead.");
      this.store.db.prepare("UPDATE invitations SET status='revoked' WHERE id=?").run(id);
      this.audit(actor, id, "invitation.revoked", {});
    });
  }
  private usableInvitation(token: unknown): Invitation {
    const unavailable = () => new ApiError(404, "INVITATION_UNAVAILABLE", "This invitation is invalid, expired or has already been used. Ask an administrator for a new link.");
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw unavailable();
    const row = this.store.db.prepare(`SELECT ${invitationColumns} FROM invitations WHERE token_hash=?`).get(digest(token)) as Invitation | undefined;
    if (!row || invitation(row).status !== "pending") throw unavailable();
    try { requireAdministrator(this.store.db, row.createdBy); } catch { throw unavailable(); }
    return row;
  }
  inspectInvitation(token: unknown): PublicInvitation {
    const { email, role, expiresAt, initialTimeMs } = this.usableInvitation(token);
    return { email, role, expiresAt, initialTimeMs };
  }
  async acceptInvitation(value: unknown): Promise<Owner> {
    const body = object(value); fields(body, ["token", "username", "password"]);
    this.usableInvitation(body.token);
    const credentials = validateCredentials(body);
    const password = await hashPassword(credentials.password);
    return transaction(this.store.db, () => {
      const invite = this.usableInvitation(body.token);
      if (this.store.db.prepare("SELECT 1 FROM users WHERE username=?").get(credentials.username)) throw new ApiError(409, "USERNAME_TAKEN", "This username is already in use. Choose another.");
      const user: Owner = { id: randomUUID(), username: credentials.username, role: invite.role };
      this.store.db.prepare("INSERT INTO users(id,username,password,created_at,role,email) VALUES(?,?,?,?,?,?)").run(user.id, user.username, password, at(), user.role, invite.email);
      this.store.db.prepare("UPDATE invitations SET status='accepted',accepted_by=? WHERE id=? AND status='pending'").run(user.id, invite.id);
      if (invite.initialTimeMs) this.workTime.adjust(invite.createdBy, user.id, invite.initialTimeMs, "Initial invitation allowance", `invitation:${invite.id}`);
      this.audit(invite.createdBy, user.id, "invitation.accepted", { invitationId: invite.id, role: user.role });
      return user;
    });
  }
  async deleteUser(actor: string, id: string, value: unknown): Promise<void> {
    const body = object(value); fields(body, ["revision", "confirmation"]);
    transaction(this.store.db, () => {
      const user = this.mutable(actor, id, body.revision);
      if (body.confirmation !== user.username) throw new ApiError(400, "DELETE_CONFIRMATION_REQUIRED", "Enter the account username to confirm deletion of its images and data.");
      if (this.store.inputUploads.has(id)) throw new ApiError(409, "USER_UPLOAD_IN_PROGRESS", "Wait for this user's image upload to finish before deleting the account.");
      if (this.store.activeJobs().some(job => job.userId === id && job.status !== "queued") || this.workTime.view(id).balance.activeTasks) throw new ApiError(409, "USER_HAS_ACTIVE_TASKS", "Wait for this user's active tasks to finish, and resolve interrupted jobs, before deleting the account.");
      this.revokeAccess(id);
      this.store.db.prepare("UPDATE users SET status='deleting',revision=revision+1 WHERE id=?").run(id);
      this.audit(actor, id, "user.deletion_started", {});
      for (const job of this.store.activeJobs().filter(job => job.userId === id)) this.store.patchJob(job.id, { status: "cancelled", stage: "Account deleted" });
    });
    await this.finishDeletion(id);
  }
  private finishDeletion(id: string): Promise<void> {
    const existing = this.deletions.get(id); if (existing) return existing;
    const operation = this.eraseUserMedia(id).finally(() => { this.deletions.delete(id); });
    this.deletions.set(id, operation); return operation;
  }
  private async eraseUserMedia(id: string) {
    const outputs = this.store.db.prepare("SELECT outputs.id,outputs.job_id AS jobId FROM outputs JOIN jobs ON jobs.id=outputs.job_id WHERE jobs.user_id=?").all(id) as { id: string; jobId: string }[];
    for (const output of outputs) {
      try { await deleteOutput(this.store, output.jobId, output.id, id); }
      catch (error) { if (!(error instanceof ApiError && error.code === "OUTPUT_NOT_FOUND")) throw error; }
    }
    for (const input of this.store.inputs(id)) {
      try { await deleteInput(this.store, input.id, id); }
      catch (error) { if (!(error instanceof ApiError && error.code === "INPUT_NOT_FOUND")) throw error; }
    }
    transaction(this.store.db, () => {
      this.revokeAccess(id);
      this.store.db.prepare("DELETE FROM idempotency WHERE user_id=?").run(id);
      for (const table of ['api_image_requests', 'api_input_requests', 'api_downloads']) this.store.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(id);
      this.store.db.prepare("DELETE FROM output_favorites WHERE user_id=?").run(id);
      this.store.db.prepare("DELETE FROM jobs WHERE user_id=?").run(id);
      this.store.db.prepare("DELETE FROM metadata WHERE key=?").run(`account:${id}`);
      this.store.db.prepare("UPDATE invitations SET email=NULL WHERE accepted_by=?").run(id);
      this.store.db.prepare("UPDATE users SET status='deleted',role='user',username=?,email=NULL,password='',revision=revision+1 WHERE id=? AND status='deleting'").run(`~deleted:${id}`, id);
    });
  }
  async recoverDeletions() {
    const users = this.store.db.prepare("SELECT id FROM users WHERE status='deleting'").all() as { id: string }[];
    for (const user of users) { try { await this.finishDeletion(user.id); } catch { /* Durable state stays pending for the next recovery pass. */ } }
  }
}
