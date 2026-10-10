import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ApiError, isUpscaleInput, isImageToolInput, type JobInput, type JobStatus, type Owner, type PublicInput, type PublicJob, type SavedOutput, type StudioSettings, type WorkerSettings } from "../../packages/contracts/index.ts";
import type { AssetObjectStore, StoredObject } from "./object-store.ts";
import { initializeAdministration, requireActiveUser } from "./administration.ts";
import { initializeWorkTime, requireWorkTime, syncJobWorkTime } from "./work-time.ts";
import { initializeApiAccess, savedTokenScopes } from './access.ts';
import { LEGACY_API_SCOPES, type ApiScope, type ApiToken } from '../../packages/contracts/access.ts';

export interface PlacementSnapshot { worker: WorkerSettings; memory: { ramBytes: number; vramBytes: number } }
export interface StoredJob extends Omit<PublicJob, "outputs"> {
  outputs: Array<SavedOutput & { favorite?: boolean }>;
  userId: string;
  snapshot: unknown;
  placements: PlacementSnapshot[];
  promptId: string | null;
  submissionStarted: boolean;
}
export interface StoredInput extends PublicInput { path?: string; object?: StoredObject; userId: string; bytes: number }
export interface StoredOutput extends SavedOutput { path?: string; object?: StoredObject }
const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value);
const jobColumns = `jobs.body, (SELECT json_group_array(favorites.output_id) FROM output_favorites AS favorites JOIN outputs ON outputs.id=favorites.output_id WHERE favorites.user_id=jobs.user_id AND outputs.job_id=jobs.id) AS favorite_ids`;
function storedJob(row: { body: string; favorite_ids: string }): StoredJob {
  const job = JSON.parse(row.body) as StoredJob;
  const favorites = new Set<string>(JSON.parse(row.favorite_ids));
  return { ...job, outputs: job.outputs.map(output => ({ ...output, favorite: favorites.has(output.id) })) };
}
function jobBody(job: StoredJob): string {
  return json({ ...job, outputs: job.outputs.map(({ favorite: _favorite, ...output }) => output) });
}
export const DEFAULT_SETTINGS: StudioSettings = {
  revision: 0, workers: [], modelConfigurations: [],
  policy: { ramReserveBytes: 4 * 1024 ** 3, vramReserveBytes: 1024 ** 3, maxConcurrentJobs: 1, idleUnloadSeconds: 0 },
};
const allowedTransitions: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["preparing", "cancelled", "failed"],
  preparing: ["running", "interrupted", "failed", "succeeded"],
  running: ["succeeded", "failed", "interrupted"],
  interrupted: ["running", "succeeded", "failed"],
  succeeded: [], failed: [], cancelled: [],
};

export class Store {
  db: DatabaseSync;
  directory: string;
  readonly objectStore: AssetObjectStore | null;
  readonly inputUploads = new Map<string, number>();
  constructor(directory: string, options: { objectStore?: AssetObjectStore | null } = {}) {
    this.directory = directory;
    this.objectStore = options.objectStore ?? null;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "studio.sqlite"));
    chmodSync(join(directory, "studio.sqlite"), 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS api_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_user_time ON jobs(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
      CREATE TABLE IF NOT EXISTS idempotency (user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, request_hash TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id), PRIMARY KEY(user_id,key));
      CREATE TABLE IF NOT EXISTS inputs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS input_deletions (input_id TEXT PRIMARY KEY REFERENCES inputs(id) ON DELETE CASCADE, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outputs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outputs_job ON outputs(job_id);
      CREATE TABLE IF NOT EXISTS output_favorites (user_id TEXT NOT NULL REFERENCES users(id), output_id TEXT NOT NULL REFERENCES outputs(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(user_id,output_id));
      CREATE TABLE IF NOT EXISTS output_deletions (output_id TEXT PRIMARY KEY REFERENCES outputs(id) ON DELETE CASCADE, created_at TEXT NOT NULL);
    `);
    initializeAdministration(this.db);
    initializeApiAccess(this.db);
    initializeWorkTime(this.db);
    const locations = this.db.prepare(`SELECT DISTINCT json_extract(body,'$.object.storeId') AS store_id FROM inputs WHERE json_type(body,'$.object') IS NOT NULL
      UNION SELECT DISTINCT json_extract(body,'$.object.storeId') AS store_id FROM outputs WHERE json_type(body,'$.object') IS NOT NULL`).all() as Array<{ store_id: string | null }>;
    if (locations.some(location => !this.objectStore || location.store_id !== this.objectStore.id)) {
      this.db.close();
      throw new ApiError(503, "MEDIA_STORE_CHANGED", "Saved images require their original object storage configuration. Restore the endpoint, bucket and prefix before starting Studio.");
    }
  }
  close() { this.db.close(); }
  beginInputUpload(userId: string): () => void {
    requireActiveUser(this.db, userId);
    this.inputUploads.set(userId, (this.inputUploads.get(userId) ?? 0) + 1);
    return () => { const remaining = (this.inputUploads.get(userId) ?? 1) - 1; if (remaining) this.inputUploads.set(userId, remaining); else this.inputUploads.delete(userId); };
  }
  metadata<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  setMetadata(key: string, value: unknown) {
    this.db.prepare("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, json(value));
  }
  settings(): StudioSettings { return this.metadata<StudioSettings>("settings") ?? structuredClone(DEFAULT_SETTINGS); }
  saveSettings(settings: StudioSettings) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.settings();
      if (current.revision !== settings.revision) throw new ApiError(409, "SETTINGS_CHANGED", "Settings changed in another window. Reload before saving.");
      const saved = { ...settings, revision: current.revision + 1 };
      this.setMetadata("settings", saved);
      this.db.exec("COMMIT");
      return saved;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  owner(): Owner | undefined { return this.db.prepare("SELECT id,username,role FROM users WHERE id=?").get(this.metadata<string>("owner-id") ?? "") as Owner | undefined; }
  createOwner(username: string, password: string): Owner {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.owner()) throw new ApiError(409, "ALREADY_CONFIGURED", "This studio already has an owner. Sign in instead.");
      const user: Owner = { id: randomUUID(), username, role: "admin" };
      this.db.prepare("INSERT INTO users(id,username,password,created_at,role) VALUES(?,?,?,?,'admin')").run(user.id, username, password, now());
      this.setMetadata("owner-id", user.id);
      this.db.exec("COMMIT");
      return user;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  passwordUser(username: string) { return this.db.prepare("SELECT id,username,role,password FROM users WHERE username=? AND status='active'").get(username) as (Owner & { password: string }) | undefined; }
  saveSession(hash: string, userId: string, expiresAt: number) {
    requireActiveUser(this.db, userId);
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
    this.db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(hash, userId, expiresAt);
  }
  session(hash: string): Owner | undefined {
    return this.db.prepare("SELECT users.id,users.username,users.role FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires_at>? AND users.status='active'").get(hash, Date.now()) as Owner | undefined;
  }
  revokeSession(hash: string) { this.db.prepare("DELETE FROM sessions WHERE hash=?").run(hash); }
  saveApiToken(userId: string, name: string, hash: string, options: { scopes: readonly ApiScope[]; expiresAt: string | null } = { scopes: LEGACY_API_SCOPES, expiresAt: null }): ApiToken {
    requireActiveUser(this.db, userId);
    const token: ApiToken = { id: randomUUID(), name, createdAt: now(), lastUsedAt: null, expiresAt: options.expiresAt, scopes: [...options.scopes] };
    this.db.prepare("INSERT INTO api_tokens(id,user_id,name,hash,created_at,scopes,expires_at) VALUES(?,?,?,?,?,?,?)").run(token.id, userId, name, hash, token.createdAt, json(token.scopes), token.expiresAt);
    return token;
  }
  apiToken(hash: string): Owner | undefined {
    return this.apiTokenAccess(hash)?.user;
  }
  apiTokenAccess(hash: string): { user: Owner; scopes: ApiScope[]; tokenId: string } | undefined {
    const row = this.db.prepare("SELECT users.id,users.username,users.role,api_tokens.id AS tokenId,api_tokens.scopes FROM api_tokens JOIN users ON users.id=api_tokens.user_id WHERE api_tokens.hash=? AND (api_tokens.expires_at IS NULL OR api_tokens.expires_at>?) AND users.status='active'").get(hash, now()) as (Owner & { scopes: string | null; tokenId: string }) | undefined;
    if (!row) return;
    this.db.prepare("UPDATE api_tokens SET last_used_at=? WHERE hash=?").run(now(), hash);
    return { user: { id: row.id, username: row.username, role: row.role }, scopes: savedTokenScopes(row.scopes), tokenId: row.tokenId };
  }
  apiTokens(userId: string): ApiToken[] { return (this.db.prepare("SELECT id,name,created_at AS createdAt,last_used_at AS lastUsedAt,expires_at AS expiresAt,scopes FROM api_tokens WHERE user_id=? ORDER BY created_at DESC").all(userId) as Array<Omit<ApiToken, 'scopes'> & { scopes: string | null }>).map(row => ({ ...row, scopes: savedTokenScopes(row.scopes) })); }
  revokeApiToken(userId: string, id: string) { this.db.prepare("DELETE FROM api_tokens WHERE user_id=? AND id=?").run(userId, id); }
  createJob(userId: string, input: JobInput, snapshot: unknown, placements: PlacementSnapshot[], modelName: string, parameters: Record<string, unknown>, key: string, requestHash: string): StoredJob {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      requireActiveUser(this.db, userId);
      const old = this.db.prepare("SELECT job_id,request_hash FROM idempotency WHERE user_id=? AND key=?").get(userId, key) as { job_id: string; request_hash: string } | undefined;
      if (old) {
        if (old.request_hash !== requestHash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This request key was already used for different settings.");
        const job = this.job(old.job_id, userId);
        this.db.exec("COMMIT");
        return job;
      }
      requireWorkTime(this.db, userId);
      // Submission can wait for worker discovery before reaching this transaction.
      // Recheck references here so a concurrent deletion cannot strand a new job.
      const inputIds = isImageToolInput(input) ? input.source.type === "input" ? [input.source.inputId] : [] : [...(input.images ?? []), ...(input.maskId ? [input.maskId] : [])];
      for (const id of inputIds) {
        this.input(id, userId);
        if (this.db.prepare("SELECT 1 FROM input_deletions WHERE input_id=?").get(id)) throw new ApiError(409, "INPUT_DELETION_PENDING", "This reference image is being deleted. Choose another image.");
      }
      if (isImageToolInput(input) && input.source.type === "output") {
        this.output(input.source.jobId, input.source.outputId, userId);
        if (this.db.prepare("SELECT 1 FROM output_deletions WHERE output_id=?").get(input.source.outputId)) throw new ApiError(409, "OUTPUT_DELETION_PENDING", "This image is being deleted. Choose another image.");
      }
      const at = now();
      const prompt = isUpscaleInput(input) ? `Upscale ${input.scale}×` : isImageToolInput(input) ? "Remove background" : input.prompt;
      const job: StoredJob = { id: randomUUID(), userId, input, snapshot, placements, modelId: input.modelId, modelName, prompt, parameters, status: "queued", stage: "Waiting for a worker", progress: null, createdAt: at, updatedAt: at, workerId: null, outputs: [], error: null, promptId: null, submissionStarted: false };
      this.db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?)").run(job.id, userId, job.status, json(job), at, at);
      this.db.prepare("INSERT INTO idempotency VALUES(?,?,?,?)").run(userId, key, requestHash, job.id);
      this.db.exec("COMMIT");
      return job;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  job(id: string, userId?: string): StoredJob {
    const row = (userId ? this.db.prepare(`SELECT ${jobColumns} FROM jobs WHERE id=? AND user_id=?`).get(id, userId) : this.db.prepare(`SELECT ${jobColumns} FROM jobs WHERE id=?`).get(id)) as { body: string; favorite_ids: string } | undefined;
    if (!row) throw new ApiError(404, "JOB_NOT_FOUND", "This job does not exist.");
    return storedJob(row);
  }
  idempotentJob(userId: string, key: string, requestHash: string): StoredJob | undefined {
    const row = this.db.prepare("SELECT job_id,request_hash FROM idempotency WHERE user_id=? AND key=?").get(userId, key) as { job_id: string; request_hash: string } | undefined;
    if (!row) return undefined;
    if (row.request_hash !== requestHash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This request key was already used for different settings.");
    return this.job(row.job_id, userId);
  }
  saveExecution(id: string, snapshot: unknown) {
    const job = this.job(id);
    if (job.submissionStarted || job.status !== "preparing") throw new Error("An execution snapshot is immutable after submission begins.");
    this.db.prepare("UPDATE jobs SET body=? WHERE id=?").run(jobBody({ ...job, snapshot }), id);
  }
  jobs(userId?: string, limit = 100): StoredJob[] {
    const rows = (userId ? this.db.prepare(`SELECT ${jobColumns} FROM jobs WHERE user_id=? ORDER BY created_at DESC LIMIT ?`).all(userId, limit) : this.db.prepare(`SELECT ${jobColumns} FROM jobs ORDER BY created_at ASC`).all()) as { body: string; favorite_ids: string }[];
    return rows.map(storedJob);
  }
  favorites(userId: string): StoredJob[] {
    const rows = this.db.prepare(`SELECT ${jobColumns} FROM jobs WHERE user_id=? AND EXISTS (SELECT 1 FROM output_favorites AS favorites JOIN outputs ON outputs.id=favorites.output_id WHERE favorites.user_id=jobs.user_id AND outputs.job_id=jobs.id) ORDER BY created_at DESC`).all(userId) as { body: string; favorite_ids: string }[];
    return rows.map(storedJob).map(job => ({ ...job, outputs: job.outputs.filter(output => output.favorite) })).filter(job => job.outputs.length > 0);
  }
  activeJobs(): StoredJob[] {
    return (this.db.prepare("SELECT body FROM jobs WHERE status IN ('queued','preparing','running','interrupted') ORDER BY created_at ASC").all() as { body: string }[]).map(row => JSON.parse(row.body));
  }
  patchJob(id: string, patch: Partial<Pick<StoredJob, "status" | "stage" | "progress" | "error" | "workerId" | "promptId" | "submissionStarted" | "outputs">>): StoredJob {
    const ownTransaction = !this.db.isTransaction;
    if (ownTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.job(id);
      if (patch.status && patch.status !== job.status && !allowedTransitions[job.status].includes(patch.status)) throw new Error(`Invalid job transition ${job.status} → ${patch.status}`);
      const updated = { ...job, ...patch, updatedAt: now() };
      syncJobWorkTime(this.db, job, updated);
      this.db.prepare("UPDATE jobs SET status=?,body=?,updated_at=? WHERE id=?").run(updated.status, jobBody(updated), updated.updatedAt, id);
      const result = this.job(id);
      if (ownTransaction) this.db.exec("COMMIT");
      return result;
    } catch (error) { if (ownTransaction) this.db.exec("ROLLBACK"); throw error; }
  }
  saveInput(input: StoredInput) {
    // Suspension revokes access immediately, but an upload already admitted while
    // active must keep its metadata so later account deletion can erase the blob.
    const admitted = this.inputUploads.has(input.userId) && this.db.prepare("SELECT 1 FROM users WHERE id=? AND status IN ('active','suspended')").get(input.userId);
    if (!admitted) requireActiveUser(this.db, input.userId);
    if (input.source) this.outputForReference(input.source.jobId, input.source.outputId, input.userId);
    this.db.prepare("INSERT INTO inputs VALUES(?,?,?)").run(input.id, input.userId, json(input));
  }
  inputForOutput(jobId: string, outputId: string, userId: string): PublicInput | undefined {
    const row = this.db.prepare("SELECT body FROM inputs WHERE user_id=? AND json_extract(body,'$.source.jobId')=? AND json_extract(body,'$.source.outputId')=? LIMIT 1").get(userId, jobId, outputId) as { body: string } | undefined;
    if (!row) return;
    const input = JSON.parse(row.body) as StoredInput;
    if (this.db.prepare("SELECT 1 FROM input_deletions WHERE input_id=?").get(input.id)) throw new ApiError(409, "INPUT_DELETION_PENDING", "This reference image is being deleted. Try again when deletion finishes.");
    return publicInput(input);
  }
  input(id: string, userId: string): StoredInput {
    const row = this.db.prepare("SELECT body FROM inputs WHERE id=? AND user_id=?").get(id, userId) as { body: string } | undefined;
    if (!row) throw new ApiError(404, "INPUT_NOT_FOUND", "This reference image does not exist.");
    return JSON.parse(row.body);
  }
  inputs(userId: string): PublicInput[] { return (this.db.prepare("SELECT body FROM inputs WHERE user_id=?").all(userId) as { body: string }[]).map(row => publicInput(JSON.parse(row.body) as StoredInput)); }
  beginInputDeletion(id: string, userId: string): StoredInput {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const input = this.input(id, userId);
      const referenced = this.db.prepare("SELECT 1 FROM jobs WHERE jobs.status IN ('queued','preparing','running','interrupted') AND (EXISTS (SELECT 1 FROM json_each(jobs.body, '$.input.images') AS image WHERE image.value=?) OR json_extract(body, '$.input.maskId')=? OR (json_extract(body, '$.input.operation') IN ('upscale','remove-background') AND json_extract(body, '$.input.source.type')='input' AND json_extract(body, '$.input.source.inputId')=?)) LIMIT 1").get(id, id, id);
      if (referenced) throw new ApiError(409, "INPUT_IN_USE", "Wait for generations using this image to finish, or cancel queued jobs, before deleting it.");
      this.db.prepare("INSERT INTO input_deletions(input_id,created_at) VALUES(?,?) ON CONFLICT(input_id) DO NOTHING").run(id, now());
      this.db.exec("COMMIT");
      return input;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  pendingInputDeletions(): Array<{ inputId: string; userId: string }> {
    return this.db.prepare("SELECT inputs.id AS inputId, inputs.user_id AS userId FROM input_deletions JOIN inputs ON inputs.id=input_deletions.input_id ORDER BY input_deletions.created_at").all() as Array<{ inputId: string; userId: string }>;
  }
  finishInputDeletion(id: string, userId: string): void {
    this.db.prepare("DELETE FROM inputs WHERE id=? AND user_id=? AND EXISTS (SELECT 1 FROM input_deletions WHERE input_id=inputs.id)").run(id, userId);
  }
  saveOutput(jobId: string, output: StoredOutput) {
    const job = this.job(jobId);
    const existing = this.db.prepare("SELECT job_id FROM outputs WHERE id=?").get(output.id) as { job_id: string } | undefined;
    if (existing && existing.job_id !== jobId) throw new ApiError(409, "OUTPUT_ID_CONFLICT", "This output belongs to another generation.");
    if (this.db.prepare("SELECT 1 FROM output_deletions WHERE output_id=?").get(output.id)) throw new ApiError(409, "OUTPUT_DELETION_PENDING", "This image is being deleted.");
    if (!existing && ["succeeded", "failed", "cancelled"].includes(job.status)) throw new ApiError(409, "JOB_FINISHED", "A finished generation cannot acquire new or deleted outputs.");
    this.db.prepare("INSERT INTO outputs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(output.id, jobId, json(output));
  }
  output(jobId: string, id: string, userId: string): StoredOutput {
    this.job(jobId, userId);
    const row = this.db.prepare("SELECT body FROM outputs WHERE id=? AND job_id=?").get(id, jobId) as { body: string } | undefined;
    if (!row) throw new ApiError(404, "OUTPUT_NOT_FOUND", "This image does not exist.");
    return JSON.parse(row.body);
  }
  outputForReference(jobId: string, id: string, userId: string): StoredOutput {
    const output = this.output(jobId, id, userId);
    if (this.db.prepare("SELECT 1 FROM output_deletions WHERE output_id=?").get(id)) throw new ApiError(409, "OUTPUT_DELETION_PENDING", "This image is being deleted. Choose another image.");
    return output;
  }
  setOutputFavorite(jobId: string, id: string, userId: string, favorite: boolean): StoredJob {
    this.output(jobId, id, userId);
    if (this.db.prepare("SELECT 1 FROM output_deletions WHERE output_id=?").get(id)) throw new ApiError(409, "OUTPUT_DELETION_PENDING", "This image is being deleted. Retry deleting it if an earlier attempt failed.");
    if (favorite) this.db.prepare("INSERT INTO output_favorites(user_id,output_id,created_at) VALUES(?,?,?) ON CONFLICT(user_id,output_id) DO NOTHING").run(userId, id, now());
    else this.db.prepare("DELETE FROM output_favorites WHERE user_id=? AND output_id=?").run(userId, id);
    return this.job(jobId, userId);
  }
  beginOutputDeletion(jobId: string, id: string, userId: string): StoredOutput {
    const output = this.output(jobId, id, userId);
    if (!["succeeded", "failed", "cancelled"].includes(this.job(jobId, userId).status)) throw new ApiError(409, "JOB_ACTIVE", "Wait for this generation to finish before deleting its images.");
    const referenced = this.db.prepare("SELECT 1 FROM jobs WHERE status IN ('queued','preparing','running','interrupted') AND json_extract(body, '$.input.operation') IN ('upscale','remove-background') AND json_extract(body, '$.input.source.type')='output' AND json_extract(body, '$.input.source.jobId')=? AND json_extract(body, '$.input.source.outputId')=? LIMIT 1").get(jobId, id);
    if (referenced) throw new ApiError(409, "OUTPUT_IN_USE", "Wait for jobs using this image to finish, or cancel queued jobs, before deleting it.");
    this.db.prepare("INSERT INTO output_deletions(output_id,created_at) VALUES(?,?) ON CONFLICT(output_id) DO NOTHING").run(id, now());
    return output;
  }
  pendingOutputDeletions(): Array<{ jobId: string; outputId: string; userId: string }> {
    return this.db.prepare("SELECT outputs.job_id AS jobId, outputs.id AS outputId, jobs.user_id AS userId FROM output_deletions JOIN outputs ON outputs.id=output_deletions.output_id JOIN jobs ON jobs.id=outputs.job_id ORDER BY output_deletions.created_at").all() as Array<{ jobId: string; outputId: string; userId: string }>;
  }
  finishOutputDeletion(jobId: string, id: string, userId: string): StoredJob {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.job(jobId, userId);
      if (!["succeeded", "failed", "cancelled"].includes(job.status)) throw new ApiError(409, "JOB_ACTIVE", "Wait for this generation to finish before deleting its images.");
      const pending = this.db.prepare("SELECT 1 FROM output_deletions JOIN outputs ON outputs.id=output_deletions.output_id WHERE outputs.id=? AND outputs.job_id=?").get(id, jobId);
      if (pending) {
        this.db.prepare("UPDATE jobs SET body=? WHERE id=?").run(jobBody({ ...job, outputs: job.outputs.filter(output => output.id !== id) }), jobId);
        this.db.prepare("DELETE FROM outputs WHERE id=? AND job_id=?").run(id, jobId);
      }
      this.db.exec("COMMIT");
      return this.job(jobId, userId);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
function publicInput(input: StoredInput): PublicInput {
  const { id, url, name, width, height, mimeType, source } = input;
  return { id, url, name, width, height, mimeType, ...(source ? { source: { jobId: source.jobId, outputId: source.outputId } } : {}) };
}
export function publicJob(job: StoredJob): PublicJob {
  const { userId: _user, snapshot: _snapshot, placements: _placements, promptId: _prompt, submissionStarted: _submitted, ...result } = job;
  return { ...result, outputs: result.outputs.map(({ id, url, mimeType, width, height, bytes, sha256, favorite }) => ({ id, url, mimeType, width, height, bytes, sha256, favorite: favorite === true })) };
}
