import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { initializeWorkTime, requireWorkTime, syncJobWorkTime, WorkTimeService } from "../../apps/server/work-time.ts";
import { engineFixture, until } from "./helpers/engine-fixture.ts";

function schema(db: DatabaseSync) {
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT,role TEXT,status TEXT);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,status TEXT,body TEXT);
    INSERT OR IGNORE INTO users VALUES('admin','Administrator','admin','active'),('alice','Alice','user','active'),('bob','Bob','user','active');`);
}
function fixture(t: TestContext) {
  const db = new DatabaseSync(":memory:"); schema(db);
  let at = 1000;
  initializeWorkTime(db, at);
  const service = new WorkTimeService({ db }, { now: () => at });
  t.after(() => db.close());
  return { db, service, get now() { return at; }, advance(ms: number) { at += ms; }, setTime(ms: number) { at = ms; },
    grant(id = "alice", amount = 60_000) { return service.adjust("admin", id, amount, "Test allowance", `grant-${id}-${at}`); } };
}
const job = (id: string, status: string, userId = "alice") => ({ id, status, userId, modelId: "sdxl-base" });

test("accounts start at zero, admins are unlimited but metered, and roles/status are checked at admission", t => {
  const f = fixture(t);
  assert.deepEqual(f.service.view("alice").balance, { userId: "alice", unlimited: false, grantedMs: 0, usedMs: 0, remainingMs: 0, activeTasks: 0, uncertainTasks: 0, sampledAt: 1000, trackedSince: null });
  assert.throws(() => requireWorkTime(f.db, "alice", f.now), { code: "SERVER_TIME_EXHAUSTED" });
  assert.throws(() => f.service.beginTask("alice", "no-credit", "local-llm"), { code: "SERVER_TIME_EXHAUSTED" });
  assert.equal(f.service.view("alice").balance.trackedSince, null, "Rejected admission rolls back account creation");
  f.service.beginTask("admin", "admin-work", "local-llm");
  f.advance(2500); f.service.endTask("admin-work");
  assert.equal(f.service.view("admin").balance.usedMs, 2500);
  assert.equal(f.service.view("admin").balance.unlimited, true);
  f.db.prepare("UPDATE users SET role='user' WHERE id='admin'").run();
  assert.throws(() => requireWorkTime(f.db, "admin", f.now), { code: "SERVER_TIME_EXHAUSTED" });
  f.db.prepare("UPDATE users SET role='admin',status='suspended' WHERE id='admin'").run();
  assert.throws(() => requireWorkTime(f.db, "admin", f.now), { code: "ACCOUNT_UNAVAILABLE" });
});

test("same-user overlapping tasks share one clock while different users have independent time", t => {
  const f = fixture(t); f.grant(); f.grant("bob");
  f.service.beginTask("alice", "first", "job", true);
  f.advance(1000); f.service.beginTask("alice", "second", "local-llm");
  f.service.beginTask("bob", "third", "local-llm");
  f.advance(2000); f.service.endTask("first");
  assert.equal(f.service.view("alice").balance.usedMs, 3000);
  f.advance(1500); f.service.endTask("second"); f.service.endTask("third");
  assert.equal(f.service.view("alice").balance.usedMs, 4500);
  assert.equal(f.service.view("bob").balance.usedMs, 3500);
  assert.equal(f.service.view("alice").sessions.length, 1);
  assert.equal(f.service.view("alice").sessions[0].durationMs, 4500);
  f.advance(1000); f.service.beginTask("alice", "fourth", "local-llm");
  f.advance(500); f.service.endTask("fourth");
  assert.equal(f.service.view("alice").balance.usedMs, 5000, "The idle gap is not charged");
  assert.equal(f.service.view("alice").sessions.length, 2);
});

test("queue time is free, preparation starts the clock, and interrupted reservations keep running until terminal", t => {
  const f = fixture(t); f.grant();
  syncJobWorkTime(f.db, job("image", "queued"), job("image", "queued"), f.now);
  f.advance(10_000);
  assert.equal(f.service.view("alice").balance.usedMs, 0);
  syncJobWorkTime(f.db, job("image", "queued"), job("image", "preparing"), f.now);
  f.advance(1000);
  syncJobWorkTime(f.db, job("image", "preparing"), job("image", "running"), f.now);
  f.advance(1000);
  syncJobWorkTime(f.db, job("image", "running"), job("image", "interrupted"), f.now);
  assert.equal(f.service.view("alice").balance.uncertainTasks, 1);
  f.advance(4000);
  syncJobWorkTime(f.db, job("image", "interrupted"), job("image", "running"), f.now);
  assert.equal(f.service.view("alice").balance.uncertainTasks, 0);
  f.advance(1000);
  syncJobWorkTime(f.db, job("image", "running"), job("image", "failed"), f.now);
  f.advance(1000);
  assert.equal(f.service.view("alice").balance.usedMs, 7000);
  assert.equal(f.service.view("alice").balance.activeTasks, 0);
  syncJobWorkTime(f.db, job("cancel", "queued"), job("cancel", "cancelled"), f.now);
  assert.equal(f.service.view("alice").sessions.length, 1);
});

test("starts, heartbeats, finish and grant retries are idempotent and cannot change the owner", t => {
  const f = fixture(t); f.grant();
  f.service.adjust("admin", "alice", 60_000, "Test allowance", "grant-alice-1000");
  assert.equal(f.service.view("alice").balance.grantedMs, 60_000);
  assert.throws(() => f.service.adjust("admin", "alice", 1, "Test allowance", "grant-alice-1000"), { code: "IDEMPOTENCY_CONFLICT" });
  f.service.beginTask("alice", "stable", "job", true);
  f.advance(500); f.service.heartbeat(); f.service.heartbeat();
  f.service.beginTask("alice", "stable", "job", true);
  assert.throws(() => f.service.beginTask("bob", "stable", "job", true), { code: "WORK_TIME_TASK_CONFLICT" });
  f.advance(500); f.service.endTask("stable"); f.service.endTask("stable");
  f.advance(500); f.service.beginTask("alice", "stable", "job", true);
  assert.equal(f.service.view("alice").balance.usedMs, 1000);
  assert.equal(f.service.view("alice").balance.activeTasks, 0, "Replaying a finished task does not reopen it");
});

test("active jobs can overrun their grant, new admissions fail, and only unused time can be revoked", t => {
  const f = fixture(t); f.grant("alice", 2000);
  f.service.beginTask("alice", "overrun", "job", true);
  f.advance(3000);
  assert.equal(f.service.view("alice").balance.remainingMs, -1000);
  assert.throws(() => requireWorkTime(f.db, "alice", f.now), { code: "SERVER_TIME_EXHAUSTED" });
  assert.throws(() => f.service.adjust("admin", "alice", -1, "Remove time", "revoke-overrun"), { code: "TIME_ALREADY_USED" });
  f.service.endTask("overrun");
  f.service.adjust("admin", "alice", 4000, "Top up", "topup-overrun");
  assert.equal(f.service.view("alice").balance.remainingMs, 3000);
  f.service.adjust("admin", "alice", -3000, "Remove unused time", "revoke-unused");
  assert.equal(f.service.view("alice").balance.usedMs, 3000);
  assert.equal(f.service.view("alice").balance.remainingMs, 0);
  assert.throws(() => f.service.adjust("bob", "alice", 1000, "Unauthorized", "bad-actor-test"), { code: "ADMIN_REQUIRED" });
});

test("grants and job transitions roll back together with their outer transaction", t => {
  const f = fixture(t);
  f.db.exec("BEGIN IMMEDIATE");
  f.service.adjust("admin", "alice", 6000, "Invitation allowance", "invite-allowance");
  syncJobWorkTime(f.db, job("atomic", "queued"), job("atomic", "preparing"), f.now);
  f.db.exec("ROLLBACK");
  assert.equal(f.service.view("alice").balance.grantedMs, 0);
  assert.equal(f.service.view("alice").balance.activeTasks, 0);
  assert.equal(f.service.view("alice").adjustments.length, 0);
  f.db.exec("BEGIN IMMEDIATE");
  f.service.adjust("admin", "alice", 6000, "Invitation allowance", "invite-allowance");
  syncJobWorkTime(f.db, job("atomic", "queued"), job("atomic", "preparing"), f.now);
  f.db.exec("COMMIT");
  f.advance(1000);
  assert.equal(f.service.view("alice").balance.usedMs, 1000);
});

test("restart retains durable reservation time and settles abandoned local helpers at their last persisted heartbeat", t => {
  const directory = mkdtempSync(join(tmpdir(), "gravity-work-time-"));
  const path = join(directory, "usage.sqlite");
  let db = new DatabaseSync(path); schema(db);
  let at = 1000; initializeWorkTime(db, at);
  let service = new WorkTimeService({ db }, { now: () => at });
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  service.adjust("admin", "alice", 60_000, "Allowance", "restart-alice");
  service.adjust("admin", "bob", 60_000, "Allowance", "restart-bob");
  const active = job("persistent", "running");
  db.prepare("INSERT INTO jobs VALUES(?,?,?)").run(active.id, active.status, JSON.stringify(active));
  service.beginTask("alice", "job:persistent", "job", true, active.modelId);
  service.beginTask("alice", "overlapping-http", "local-llm");
  service.beginTask("bob", "http-only", "local-llm");
  at = 3000; service.heartbeat(); db.close();
  at = 10_000; db = new DatabaseSync(path); schema(db); initializeWorkTime(db, at); initializeWorkTime(db, at);
  service = new WorkTimeService({ db }, { now: () => at });
  assert.equal(service.view("alice").balance.usedMs, 9000);
  assert.equal(service.view("alice").balance.activeTasks, 1);
  assert.equal(service.view("bob").balance.usedMs, 2000);
  assert.equal(service.view("bob").balance.activeTasks, 0);
  assert.equal(service.view("bob").sessions[0].endedAt, 3000);
  at = 11_000; service.endTask("job:persistent");
  assert.equal(service.view("alice").balance.usedMs, 10_000);
  assert.equal(service.view("alice").sessions.length, 1);
});

test("first activation never backfills old completed jobs or guesses the start of existing active work", t => {
  const db = new DatabaseSync(":memory:"); schema(db); t.after(() => db.close());
  for (const [id, status] of [["old-completed", "succeeded"], ["old-cancelled", "cancelled"], ["existing-active", "interrupted"], ["existing-queue", "queued"]]) {
    db.prepare("INSERT INTO jobs VALUES(?,?,?)").run(id, status, JSON.stringify({ ...job(id, status), createdAt: "2020-01-01T00:00:00Z" }));
  }
  initializeWorkTime(db, 50_000);
  const service = new WorkTimeService({ db }, { now: () => 51_000 });
  const result = service.view("alice");
  assert.equal(result.balance.trackedSince, 50_000);
  assert.equal(result.balance.usedMs, 1000);
  assert.equal(result.balance.activeTasks, 1);
  assert.equal(result.balance.uncertainTasks, 1);
  assert.equal(result.sessions[0].startedAt, 50_000);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_time_tasks").get()!.n, 1);
});

test("history is capped at 100 displayed rows without deleting older accounting records", t => {
  const f = fixture(t); f.grant("alice", 100_000);
  for (let i = 0; i < 105; i++) {
    f.service.beginTask("alice", `task:${i}`, "local-llm"); f.advance(10); f.service.endTask(`task:${i}`);
    f.service.adjust("admin", "alice", 1, "Adjustment", `history-adjust-${i}`);
  }
  assert.equal(f.service.view("alice").sessions.length, 100);
  assert.equal(f.service.view("alice").adjustments.length, 100);
  assert.equal(f.service.view("alice").balance.usedMs, 1050);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM work_time_sessions").get()!.n, 105);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM work_time_adjustments").get()!.n, 106);
  f.db.prepare("UPDATE users SET status='deleted',username='Deleted account' WHERE id='alice'").run();
  assert.equal(f.service.list().find(account => account.id === "alice")!.balance.usedMs, 1050);
});

test("clock regression never refunds persisted usage or ends a task before its start", t => {
  const f = fixture(t); f.grant(); f.service.beginTask("alice", "clock", "local-llm");
  f.advance(1000); f.service.heartbeat(); f.setTime(500); f.service.endTask("clock");
  assert.equal(f.service.view("alice").balance.usedMs, 1000);
  assert.equal(f.service.view("alice").sessions[0].durationMs, 1000);
});

test("adjustments reject fractional, overflowing, zero and unaudited grants", t => {
  const f = fixture(t);
  for (const delta of [0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 10_000 * 60 * 60 * 1000 + 1]) {
    assert.throws(() => f.service.adjust("admin", "alice", delta, "Reason", "invalid-delta"), { code: "INVALID_WORK_TIME_ADJUSTMENT" });
  }
  assert.throws(() => f.service.adjust("admin", "alice", 1, " ", "invalid-reason"), { code: "INVALID_WORK_TIME_ADJUSTMENT" });
  assert.throws(() => f.service.adjust("admin", "alice", 1, "Reason", "short"), { code: "INVALID_WORK_TIME_ADJUSTMENT" });
  assert.equal(f.service.view("alice").adjustments.length, 0);
});

test("the real scheduler waits for a top-up, then executes; submission replay remains valid after quota exhaustion", async t => {
  const f = await engineFixture(); t.after(f.close);
  const key = "work-time-scheduler";
  const job = await f.queue({}, key);
  f.store.db.prepare("UPDATE users SET role='user' WHERE id=?").run(f.owner.id);
  assert.throws(() => f.store.patchJob(job.id, { status: "preparing", workerId: "worker-0" }), { code: "SERVER_TIME_EXHAUSTED" });
  assert.equal(f.store.job(job.id).status, "queued", "Atomic admission rolls back the job and ledger together");
  await f.engine.tick();
  assert.equal(f.store.job(job.id).status, "queued");
  assert.equal(f.store.job(job.id).stage, "Waiting for more server time");
  assert.equal(f.engine.workTime.view(f.owner.id).balance.usedMs, 0);
  await assert.rejects(f.engine.submit(f.owner.id, { modelId: "sdxl-base", prompt: "Another image" }, "blocked-submit"), { code: "SERVER_TIME_EXHAUSTED" });
  f.store.db.prepare("INSERT INTO users(id,username,password,created_at,role) VALUES('grant-admin','grant-admin','hash','2026-01-01','admin')").run();
  f.engine.workTime.adjust("grant-admin", f.owner.id, 60_000, "Top up waiting user", "scheduler-topup");
  await f.engine.tick(); await until(() => f.store.job(job.id).status === "running");
  assert.equal(f.engine.workTime.view(f.owner.id).balance.activeTasks, 1);
  f.complete(0, job.id); await until(() => f.store.job(job.id).status === "succeeded");
  assert.equal(f.engine.workTime.view(f.owner.id).balance.activeTasks, 0);
  assert(f.engine.workTime.view(f.owner.id).balance.usedMs >= 0);
  const remaining = f.engine.workTime.view(f.owner.id).balance.remainingMs;
  f.engine.workTime.adjust("grant-admin", f.owner.id, -remaining, "Remove remaining time", "scheduler-revoke");
  const replay = await f.engine.submit(f.owner.id, { modelId: "sdxl-base", prompt: "A ceramic cup", seed: 42 }, key);
  assert.equal(replay.id, job.id, "Exhaustion does not invalidate an already accepted idempotent request");
});
