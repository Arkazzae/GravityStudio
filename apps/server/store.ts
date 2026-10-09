import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ApiError, type GenerationInput, type JobStatus, type Owner, type PublicInput, type PublicJob, type SavedOutput, type StudioSettings, type WorkerSettings } from "../../packages/contracts/index.ts";

export interface PlacementSnapshot { worker: WorkerSettings; memory: { ramBytes: number; vramBytes: number } }
export interface StoredJob extends Omit<PublicJob, "outputs"> {
  outputs: Array<SavedOutput & { favorite?: boolean }>;
  userId: string;
  snapshot: unknown;
  placements: PlacementSnapshot[];
  promptId: string | null;
  submissionStarted: boolean;
}
export interface StoredInput extends PublicInput { path: string; userId: string; bytes: number }
export interface StoredOutput extends SavedOutput { path: string }
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
  constructor(directory: string) {
    this.directory = directory;
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
      CREATE TABLE IF NOT EXISTS outputs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outputs_job ON outputs(job_id);
      CREATE TABLE IF NOT EXISTS output_favorites (user_id TEXT NOT NULL REFERENCES users(id), output_id TEXT NOT NULL REFERENCES outputs(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(user_id,output_id));
    `);
  }
  close() { this.db.close(); }
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
  owner(): Owner | undefined { return this.db.prepare("SELECT id,username FROM users LIMIT 1").get() as Owner | undefined; }
  createOwner(username: string, password: string): Owner {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.owner()) throw new ApiError(409, "ALREADY_CONFIGURED", "This studio already has an owner. Sign in instead.");
      const user = { id: randomUUID(), username };
      this.db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(user.id, username, password, now());
      this.db.exec("COMMIT");
      return user;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  passwordUser(username: string) { return this.db.prepare("SELECT id,username,password FROM users WHERE username=?").get(username) as (Owner & { password: string }) | undefined; }
  saveSession(hash: string, userId: string, expiresAt: number) {
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
    this.db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(hash, userId, expiresAt);
  }
  session(hash: string): Owner | undefined {
    return this.db.prepare("SELECT users.id,users.username FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires_at>?").get(hash, Date.now()) as Owner | undefined;
  }
  revokeSession(hash: string) { this.db.prepare("DELETE FROM sessions WHERE hash=?").run(hash); }
  saveApiToken(userId: string, name: string, hash: string) {
    const token = { id: randomUUID(), name, createdAt: now() };
    this.db.prepare("INSERT INTO api_tokens(id,user_id,name,hash,created_at) VALUES(?,?,?,?,?)").run(token.id, userId, name, hash, token.createdAt);
    return token;
  }
  apiToken(hash: string): Owner | undefined {
    const user = this.db.prepare("SELECT users.id,users.username FROM api_tokens JOIN users ON users.id=api_tokens.user_id WHERE api_tokens.hash=?").get(hash) as Owner | undefined;
    if (user) this.db.prepare("UPDATE api_tokens SET last_used_at=? WHERE hash=?").run(now(), hash);
    return user;
  }
  apiTokens(userId: string) { return this.db.prepare("SELECT id,name,created_at AS createdAt,last_used_at AS lastUsedAt FROM api_tokens WHERE user_id=? ORDER BY created_at DESC").all(userId); }
  revokeApiToken(userId: string, id: string) { this.db.prepare("DELETE FROM api_tokens WHERE user_id=? AND id=?").run(userId, id); }
  createJob(userId: string, input: GenerationInput, snapshot: unknown, placements: PlacementSnapshot[], modelName: string, parameters: Record<string, unknown>, key: string, requestHash: string): StoredJob {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db.prepare("SELECT job_id,request_hash FROM idempotency WHERE user_id=? AND key=?").get(userId, key) as { job_id: string; request_hash: string } | undefined;
      if (old) {
        if (old.request_hash !== requestHash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This request key was already used for different settings.");
        const job = this.job(old.job_id, userId);
        this.db.exec("COMMIT");
        return job;
      }
      const at = now();
      const job: StoredJob = { id: randomUUID(), userId, input, snapshot, placements, modelId: input.modelId, modelName, prompt: input.prompt, parameters, status: "queued", stage: "Waiting for a worker", progress: null, createdAt: at, updatedAt: at, workerId: null, outputs: [], error: null, promptId: null, submissionStarted: false };
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
    const job = this.job(id);
    if (patch.status && patch.status !== job.status && !allowedTransitions[job.status].includes(patch.status)) throw new Error(`Invalid job transition ${job.status} → ${patch.status}`);
    const updated = { ...job, ...patch, updatedAt: now() };
    this.db.prepare("UPDATE jobs SET status=?,body=?,updated_at=? WHERE id=?").run(updated.status, jobBody(updated), updated.updatedAt, id);
    return this.job(id);
  }
  saveInput(input: StoredInput) { this.db.prepare("INSERT INTO inputs VALUES(?,?,?)").run(input.id, input.userId, json(input)); }
  input(id: string, userId: string): StoredInput {
    const row = this.db.prepare("SELECT body FROM inputs WHERE id=? AND user_id=?").get(id, userId) as { body: string } | undefined;
    if (!row) throw new ApiError(404, "INPUT_NOT_FOUND", "This reference image does not exist.");
    return JSON.parse(row.body);
  }
  inputs(userId: string): PublicInput[] { return (this.db.prepare("SELECT body FROM inputs WHERE user_id=?").all(userId) as { body: string }[]).map(row => { const { path: _path, userId: _user, bytes: _bytes, ...value } = JSON.parse(row.body) as StoredInput; return value; }); }
  saveOutput(jobId: string, output: StoredOutput) {
    this.db.prepare("INSERT INTO outputs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(output.id, jobId, json(output));
  }
  output(jobId: string, id: string, userId: string): StoredOutput {
    this.job(jobId, userId);
    const row = this.db.prepare("SELECT body FROM outputs WHERE id=? AND job_id=?").get(id, jobId) as { body: string } | undefined;
    if (!row) throw new ApiError(404, "OUTPUT_NOT_FOUND", "This image does not exist.");
    return JSON.parse(row.body);
  }
  setOutputFavorite(jobId: string, id: string, userId: string, favorite: boolean): StoredJob {
    this.output(jobId, id, userId);
    if (favorite) this.db.prepare("INSERT INTO output_favorites(user_id,output_id,created_at) VALUES(?,?,?) ON CONFLICT(user_id,output_id) DO NOTHING").run(userId, id, now());
    else this.db.prepare("DELETE FROM output_favorites WHERE user_id=? AND output_id=?").run(userId, id);
    return this.job(jobId, userId);
  }
}
export function publicJob(job: StoredJob): PublicJob {
  const { userId: _user, snapshot: _snapshot, placements: _placements, promptId: _prompt, submissionStarted: _submitted, ...result } = job;
  return { ...result, outputs: result.outputs.map(output => ({ ...output, favorite: output.favorite === true })) };
}
