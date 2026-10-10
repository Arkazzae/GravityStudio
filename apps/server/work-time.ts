import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ApiError } from "../../packages/contracts/index.ts";
import type { WorkTimeAdjustment, WorkTimeBalance, WorkTimeDetails, WorkTimeTaskKind, WorkTimeUser } from "../../packages/contracts/work-time.ts";

interface MeteredJob { id: string; userId: string; modelId: string; status: string }
interface Account { granted_ms: number; used_ms: number; metered_at: number; created_at: number }
type User = Omit<WorkTimeUser, "balance">;
const activeStates = new Set(["preparing", "running", "interrupted"]);
const terminalStates = new Set(["succeeded", "failed", "cancelled"]);
const maxAdjustmentMs = 10_000 * 60 * 60 * 1000;

function atomic<T>(db: DatabaseSync, work: () => T): T {
  // Savepoints compose with the caller's job or invitation transaction.
  db.exec("SAVEPOINT work_time_write");
  try { const result = work(); db.exec("RELEASE work_time_write"); return result; }
  catch (error) { db.exec("ROLLBACK TO work_time_write; RELEASE work_time_write"); throw error; }
}

function timestamp(at: number): number {
  if (!Number.isSafeInteger(at) || at < 0) throw new ApiError(500, "INVALID_WORK_TIME_CLOCK", "The server clock cannot be used to measure work time.");
  return at;
}

function user(db: DatabaseSync, userId: string): User {
  const found = db.prepare("SELECT id,username,role,status FROM users WHERE id=?").get(userId) as User | undefined;
  if (!found) throw new ApiError(404, "USER_NOT_FOUND", "This account does not exist.");
  return found;
}

function checkpoint(db: DatabaseSync, userId: string, at: number): number {
  timestamp(at);
  db.prepare("INSERT OR IGNORE INTO work_time_accounts(user_id,metered_at,created_at) VALUES(?,?,?)").run(userId, at, at);
  const account = db.prepare("SELECT * FROM work_time_accounts WHERE user_id=?").get(userId) as unknown as Account;
  const effectiveAt = Math.max(at, account.metered_at);
  const active = db.prepare("SELECT 1 FROM work_time_tasks WHERE user_id=? AND ended_at IS NULL LIMIT 1").get(userId);
  const used = account.used_ms + (active ? effectiveAt - account.metered_at : 0);
  if (!Number.isSafeInteger(used)) throw new ApiError(500, "WORK_TIME_OVERFLOW", "The measured server time exceeds the supported range.");
  db.prepare("UPDATE work_time_accounts SET used_ms=?,metered_at=? WHERE user_id=?").run(used, effectiveAt, userId);
  return effectiveAt;
}

function balance(db: DatabaseSync, userId: string, at: number): WorkTimeBalance {
  timestamp(at);
  const accountUser = user(db, userId);
  const account = db.prepare("SELECT * FROM work_time_accounts WHERE user_id=?").get(userId) as unknown as Account | undefined;
  const counts = db.prepare("SELECT COUNT(*) AS active,COALESCE(SUM(uncertain),0) AS uncertain FROM work_time_tasks WHERE user_id=? AND ended_at IS NULL").get(userId) as { active: number; uncertain: number };
  const grantedMs = account?.granted_ms ?? 0;
  const usedMs = (account?.used_ms ?? 0) + (counts.active && account ? Math.max(0, at - account.metered_at) : 0);
  return { userId, unlimited: accountUser.role === "admin", grantedMs, usedMs, remainingMs: grantedMs - usedMs, activeTasks: counts.active, uncertainTasks: counts.uncertain, sampledAt: at, trackedSince: account?.created_at ?? null };
}

/** Check the current role and status on every admission, never a client claim. */
export function requireWorkTime(db: DatabaseSync, userId: string, at = Date.now()): void {
  if (user(db, userId).status !== "active") throw new ApiError(403, "ACCOUNT_UNAVAILABLE", "This account cannot start new work.");
  const current = balance(db, userId, at);
  if (!current.unlimited && current.remainingMs <= 0) throw new ApiError(403, "SERVER_TIME_EXHAUSTED", "Your server time is exhausted. Ask an administrator to add more time.");
}

function begin(db: DatabaseSync, userId: string, taskId: string, kind: WorkTimeTaskKind, durable: boolean, modelId: string, at: number, recovering = false): void {
  atomic(db, () => {
    const previous = db.prepare("SELECT user_id,kind,durable,model_id FROM work_time_tasks WHERE id=?").get(taskId);
    if (previous) {
      if (previous.user_id !== userId || previous.kind !== kind || previous.durable !== Number(durable) || previous.model_id !== modelId) throw new ApiError(409, "WORK_TIME_TASK_CONFLICT", "This task already belongs to a different work-time record.");
      return; // Reconciliation cannot reopen an ended task or charge it twice.
    }
    user(db, userId);
    const effectiveAt = checkpoint(db, userId, at);
    if (!recovering) requireWorkTime(db, userId, effectiveAt);
    if (!db.prepare("SELECT 1 FROM work_time_tasks WHERE user_id=? AND ended_at IS NULL LIMIT 1").get(userId)) {
      db.prepare("INSERT INTO work_time_sessions(id,user_id,started_at) VALUES(?,?,?)").run(randomUUID(), userId, effectiveAt);
    }
    db.prepare("INSERT INTO work_time_tasks(id,user_id,kind,model_id,durable,started_at) VALUES(?,?,?,?,?,?)").run(taskId, userId, kind, modelId, Number(durable), effectiveAt);
  });
}

function finish(db: DatabaseSync, taskId: string, at: number): void {
  atomic(db, () => {
    const task = db.prepare("SELECT user_id FROM work_time_tasks WHERE id=? AND ended_at IS NULL").get(taskId);
    if (!task) return;
    const userId = String(task.user_id);
    const effectiveAt = checkpoint(db, userId, at);
    db.prepare("UPDATE work_time_tasks SET ended_at=?,uncertain=0 WHERE id=?").run(effectiveAt, taskId);
    if (!db.prepare("SELECT 1 FROM work_time_tasks WHERE user_id=? AND ended_at IS NULL LIMIT 1").get(userId)) {
      db.prepare("UPDATE work_time_sessions SET ended_at=? WHERE user_id=? AND ended_at IS NULL").run(effectiveAt, userId);
    }
  });
}

/** Call after user migrations. Existing finished jobs are deliberately not backfilled. */
export function initializeWorkTime(db: DatabaseSync, at = Date.now()): void {
  timestamp(at);
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_time_accounts(
      user_id TEXT PRIMARY KEY REFERENCES users(id), granted_ms INTEGER NOT NULL DEFAULT 0,
      used_ms INTEGER NOT NULL DEFAULT 0, metered_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS work_time_tasks(
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
      model_id TEXT NOT NULL, durable INTEGER NOT NULL, uncertain INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL, ended_at INTEGER);
    CREATE INDEX IF NOT EXISTS work_time_active ON work_time_tasks(user_id) WHERE ended_at IS NULL;
    CREATE TABLE IF NOT EXISTS work_time_sessions(
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), started_at INTEGER NOT NULL, ended_at INTEGER);
    CREATE INDEX IF NOT EXISTS work_time_sessions_user ON work_time_sessions(user_id,started_at);
    CREATE UNIQUE INDEX IF NOT EXISTS work_time_session_active ON work_time_sessions(user_id) WHERE ended_at IS NULL;
    CREATE TABLE IF NOT EXISTS work_time_adjustments(
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), actor_id TEXT NOT NULL REFERENCES users(id),
      amount_ms INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS work_time_adjustments_user ON work_time_adjustments(user_id,created_at);
  `);
  atomic(db, () => {
    // HTTP/local-LLM operations cannot survive coordinator restart. Their last
    // persisted checkpoint is the last known occupied time; do not invent more.
    const abandoned = db.prepare(`SELECT t.id,a.metered_at FROM work_time_tasks t
      JOIN work_time_accounts a ON a.user_id=t.user_id WHERE t.ended_at IS NULL AND t.durable=0`).all();
    for (const task of abandoned) finish(db, String(task.id), Number(task.metered_at));
    for (const row of db.prepare("SELECT body FROM jobs WHERE status IN ('preparing','running','interrupted')").all()) {
      const job = JSON.parse(String(row.body)) as MeteredJob;
      begin(db, job.userId, `job:${job.id}`, "job", true, job.modelId, at, true);
      db.prepare("UPDATE work_time_tasks SET uncertain=? WHERE id=? AND ended_at IS NULL").run(Number(job.status === "interrupted"), `job:${job.id}`);
    }
  });
}

/** The caller must include this and its job update in one transaction. */
export function syncJobWorkTime(db: DatabaseSync, previous: MeteredJob, next: MeteredJob, at = Date.now()): void {
  if (previous.id !== next.id || previous.userId !== next.userId) throw new ApiError(409, "WORK_TIME_TASK_CONFLICT", "A job cannot change its work-time owner.");
  const id = `job:${next.id}`;
  if (previous.status === "queued" && activeStates.has(next.status)) begin(db, next.userId, id, "job", true, next.modelId, at);
  if (terminalStates.has(next.status)) finish(db, id, at);
  else if (activeStates.has(next.status)) db.prepare("UPDATE work_time_tasks SET uncertain=? WHERE id=? AND ended_at IS NULL").run(Number(next.status === "interrupted"), id);
}

export class WorkTimeService {
  readonly db: DatabaseSync;
  readonly now: () => number;
  constructor(store: { db: DatabaseSync }, options: { now?: () => number } = {}) {
    this.db = store.db;
    this.now = options.now ?? Date.now;
  }
  view(userId: string): WorkTimeDetails {
    const at = this.now();
    return {
      balance: balance(this.db, userId, at),
      adjustments: this.db.prepare(`SELECT id,user_id AS userId,actor_id AS actorId,amount_ms AS amountMs,reason,created_at AS createdAt
        FROM work_time_adjustments WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100`).all(userId) as unknown as WorkTimeAdjustment[],
      sessions: this.db.prepare(`SELECT id,started_at AS startedAt,ended_at AS endedAt,MAX(0,COALESCE(ended_at,?)-started_at) AS durationMs
        FROM work_time_sessions WHERE user_id=? ORDER BY started_at DESC,rowid DESC LIMIT 100`).all(at, userId) as unknown as WorkTimeDetails["sessions"],
    };
  }
  list(): WorkTimeUser[] {
    const at = this.now();
    return (this.db.prepare("SELECT id,username,role,status FROM users ORDER BY username,id").all() as unknown as User[]).map(account => ({ ...account, balance: balance(this.db, account.id, at) }));
  }
  adjust(adminId: string, userId: string, deltaMs: number, reason: string, idempotencyKey: string): WorkTimeDetails {
    if (!Number.isSafeInteger(deltaMs) || deltaMs === 0 || Math.abs(deltaMs) > maxAdjustmentMs ||
        typeof reason !== "string" || !reason.trim() || reason.trim().length > 240 ||
        typeof idempotencyKey !== "string" || !/^[a-zA-Z0-9_.:-]{8,128}$/.test(idempotencyKey)) {
      throw new ApiError(400, "INVALID_WORK_TIME_ADJUSTMENT", "Supply nonzero whole milliseconds (up to 10,000 hours), a reason of 1–240 characters and a unique request key of 8–128 characters.");
    }
    return atomic(this.db, () => {
      const actor = user(this.db, adminId);
      if (actor.role !== "admin" || actor.status !== "active") throw new ApiError(403, "ADMIN_REQUIRED", "Only an active administrator can adjust server time.");
      const target = user(this.db, userId);
      if (target.status === "deleting" || target.status === "deleted") throw new ApiError(409, "ACCOUNT_UNAVAILABLE", "This account is being deleted or has been deleted.");
      const old = this.db.prepare("SELECT * FROM work_time_adjustments WHERE id=?").get(idempotencyKey);
      const note = reason.trim();
      if (old) {
        if (old.user_id !== userId || old.actor_id !== adminId || old.amount_ms !== deltaMs || old.reason !== note) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This request key already belongs to another time adjustment.");
        return this.view(userId);
      }
      const at = checkpoint(this.db, userId, this.now());
      const current = balance(this.db, userId, at);
      if (deltaMs < 0 && current.remainingMs + deltaMs < 0) throw new ApiError(409, "TIME_ALREADY_USED", "Only unused server time can be removed.");
      if (!Number.isSafeInteger(current.grantedMs + deltaMs)) throw new ApiError(400, "WORK_TIME_OVERFLOW", "The server-time allowance is too large.");
      this.db.prepare("UPDATE work_time_accounts SET granted_ms=granted_ms+? WHERE user_id=?").run(deltaMs, userId);
      this.db.prepare("INSERT INTO work_time_adjustments(id,user_id,actor_id,amount_ms,reason,created_at) VALUES(?,?,?,?,?,?)").run(idempotencyKey, userId, adminId, deltaMs, note, at);
      return this.view(userId);
    });
  }
  beginTask(userId: string, taskId: string, kind: WorkTimeTaskKind, durable = false, modelId = ""): void {
    if (typeof taskId !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(taskId) || !["job", "local-llm", "supporting"].includes(kind) || typeof durable !== "boolean" || typeof modelId !== "string" || modelId.length > 160) throw new ApiError(400, "INVALID_WORK_TIME_TASK", "Invalid server-time task.");
    begin(this.db, userId, taskId, kind, durable, modelId, this.now());
  }
  endTask(taskId: string): void { finish(this.db, taskId, this.now()); }
  heartbeat(): void {
    const at = this.now();
    atomic(this.db, () => {
      for (const row of this.db.prepare("SELECT DISTINCT user_id FROM work_time_tasks WHERE ended_at IS NULL").all()) checkpoint(this.db, String(row.user_id), at);
    });
  }
}
