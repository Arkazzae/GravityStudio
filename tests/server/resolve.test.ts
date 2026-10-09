import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createStudioServer } from "../../apps/server/http.ts";
import { createSession, digest } from "../../apps/server/auth.ts";
import { completed } from "../inference/fake-comfy.ts";
import { engineFixture, until } from "./helpers/engine-fixture.ts";

async function unknownJob(fixture: Awaited<ReturnType<typeof engineFixture>>) {
  fixture.workers[0].state.postBehavior = "drop-before-accept";
  const job = await fixture.queue();
  await fixture.engine.tick();
  await until(() => fixture.store.job(job.id).status === "interrupted" && !fixture.engine.flights.has(job.id));
  return job;
}

test("owner closing a missing generation releases its lease without replaying its submission", async t => {
  const fixture = await engineFixture({ maxConcurrent: 1 }); t.after(fixture.close);
  const job = await unknownJob(fixture);
  const next = await fixture.queue({ prompt: "The next image" });
  await fixture.engine.tick();
  assert.equal(fixture.store.job(next.id).status, "queued");
  fixture.workers[0].state.postBehavior = "normal";
  const closed = await fixture.engine.resolve(fixture.owner.id, job.id);
  assert.equal(closed.status, "failed");
  assert.equal(closed.stage, "Closed by owner");
  assert.match(closed.error!, /owner acknowledged.*not submitted again/);
  await until(() => fixture.store.job(next.id).status === "running");
  assert.equal(fixture.workers[0].state.submissions.length, 2);
  assert.equal(fixture.workers[0].state.submissions.filter(item => item.prompt_id === job.id).length, 1);
  await fixture.restart();
  assert.equal(fixture.store.job(job.id).stage, "Closed by owner");
});

test("a generation rediscovered in the worker queue cannot be closed and resumes observation", async t => {
  const fixture = await engineFixture(); t.after(fixture.close);
  const job = await unknownJob(fixture);
  const submitted = fixture.workers[0].state.submissions[0];
  fixture.workers[0].state.pending.push([1, job.id, submitted.prompt, submitted.extra_data, ["output"]]);
  await assert.rejects(fixture.engine.resolve(fixture.owner.id, job.id), { status: 409, code: "JOB_STILL_REPORTED" });
  await until(() => fixture.store.job(job.id).status === "running");
  assert.equal(fixture.store.activeJobs().length, 1);
  fixture.complete(0, job.id);
  await until(() => fixture.store.job(job.id).status === "succeeded");
  assert.equal(fixture.workers[0].state.submissions.length, 1);
});

test("a known legacy prompt is checked even when UUID metadata has disappeared", async t => {
  const fixture = await engineFixture(); t.after(fixture.close);
  fixture.workers[0].state.postBehavior = "legacy-id";
  const job = await fixture.queue(); await fixture.engine.tick();
  await until(() => fixture.store.job(job.id).status === "running");
  fixture.workers[0].state.pending = [];
  await until(() => fixture.store.job(job.id).status === "interrupted" && !fixture.engine.flights.has(job.id));
  fixture.workers[0].state.history["legacy-prompt-id"] = completed();
  await assert.rejects(fixture.engine.resolve(fixture.owner.id, job.id), { status: 409, code: "JOB_STILL_REPORTED" });
  await until(() => fixture.store.job(job.id).status === "succeeded");
  assert.equal(fixture.workers[0].state.submissions.length, 1);
});

test("worker failures and concurrent status changes keep the reservation", async t => {
  const fixture = await engineFixture(); t.after(fixture.close);
  const job = await unknownJob(fixture);
  const previous = fixture.workers[0].state.responseOverride;
  fixture.workers[0].state.responseOverride = path => path === "/queue" ? { status: 503, body: "Unavailable" } : previous?.(path);
  await assert.rejects(fixture.engine.resolve(fixture.owner.id, job.id));
  assert.equal(fixture.store.job(job.id).status, "interrupted");
  fixture.workers[0].state.responseOverride = previous;
  fixture.workers[0].state.queueHook = () => { fixture.store.patchJob(job.id, { status: "running" }); };
  await assert.rejects(fixture.engine.resolve(fixture.owner.id, job.id), { status: 409, code: "JOB_STATE_CHANGED" });
  assert.equal(fixture.store.activeJobs().length, 1);
  assert.equal(fixture.workers[0].state.submissions.length, 1);
});

test("closing unknown jobs requires an owner browser session, Origin and explicit acknowledgement", async t => {
  const fixture = await engineFixture();
  const origin = "http://localhost:4321";
  const server = await createStudioServer({ store: fixture.store, engine: fixture.engine, allowedOrigins: [origin], setupSecret: "fixture-key" });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fixture.close(); });
  const job = await unknownJob(fixture);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jobs/${job.id}/resolve`;
  const cookie = createSession(fixture.store, fixture.owner, false).split(";")[0];
  const token = "fixture-bearer-secret";
  fixture.store.saveApiToken(fixture.owner.id, "Client", digest(token));
  const request = (headers: Record<string, string>, body: unknown = { acknowledge: true }) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const denied = await request({ Authorization: `Bearer ${token}` });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, "SESSION_REQUIRED");
  assert.equal((await request({ Cookie: cookie })).status, 403);
  assert.equal((await request({ Cookie: cookie, Origin: origin }, {})).status, 400);
  assert.equal(fixture.store.job(job.id).status, "interrupted");
  const resolved = await request({ Cookie: cookie, Origin: origin });
  assert.equal(resolved.status, 200);
  assert.equal((await resolved.json()).job.stage, "Closed by owner");
  assert.equal((await request({ Cookie: cookie, Origin: origin })).status, 409);
});
