import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createStudioServer } from "../../apps/server/http.ts";
import { createSession, digest } from "../../apps/server/auth.ts";
import { RuntimeSetup } from "../../apps/server/runtime.ts";
import { engineFixture, until } from "./helpers/engine-fixture.ts";

test("manual cache release requests Comfy cleanup once and preserves queued jobs", async t => {
  const fixture = await engineFixture(); t.after(fixture.close);
  const job = await fixture.queue();
  const before = fixture.store.job(job.id);
  assert.equal((await fixture.engine.state(fixture.owner.id)).workers[0].canRelease, true);
  assert.deepEqual(await fixture.engine.releaseWorkerMemory("worker-0"), { requested: true });
  assert.equal(fixture.workers[0].state.frees, 1);
  assert.deepEqual(fixture.store.job(job.id), before, "releasing cache must not cancel, submit or modify waiting work");
  assert.equal((await fixture.engine.state(fixture.owner.id)).workers[0].canRelease, false);
  await assert.rejects(fixture.engine.releaseWorkerMemory("worker-0"), { status: 409, code: "WORKER_RELEASE_PENDING" });
  assert.equal(fixture.workers[0].state.frees, 1, "a repeated click during release does not send a second request");
});

for (const location of ["local", "remote"] as const) {
  test(`manual cache release protects active and interrupted work across ${location} GPU aliases`, async t => {
    const fixture = await engineFixture({ count: 2, location }); t.after(fixture.close);
    const settings = fixture.store.settings();
    settings.workers[1].deviceIds = [...settings.workers[0].deviceIds];
    fixture.store.saveSettings(settings);
    const job = await fixture.queue(); await fixture.engine.tick();
    await until(() => fixture.store.job(job.id).status === "running");
    for (const status of ["running", "interrupted"] as const) {
      if (status === "interrupted") {
        fixture.workers[0].state.pending = []; fixture.workers[0].state.running = [];
        await until(() => fixture.store.job(job.id).status === "interrupted" && !fixture.engine.flights.has(job.id));
      }
      const before = fixture.store.job(job.id);
      assert.deepEqual((await fixture.engine.state(fixture.owner.id)).workers.map(worker => worker.canRelease), [false, false]);
      for (const id of ["worker-0", "worker-1"]) await assert.rejects(fixture.engine.releaseWorkerMemory(id), { status: 409, code: "WORKER_BUSY" });
      assert.deepEqual(fixture.workers.map(worker => worker.state.frees), [0, 0]);
      assert.deepEqual(fixture.store.job(job.id), before, `${status} generation keeps its state and reservation`);
    }
  });
}

test("manual cache release rechecks the actual Comfy queue for external work", async t => {
  const fixture = await engineFixture(); t.after(fixture.close);
  await fixture.engine.refreshWorkers();
  fixture.workers[0].state.pending.push([1, "outside-studio", {}, {}, []]);
  await assert.rejects(fixture.engine.releaseWorkerMemory("worker-0"), { status: 409, code: "WORKER_BUSY" });
  assert.equal(fixture.workers[0].state.frees, 0);
  assert.equal(fixture.workers[0].state.pending.length, 1);
});

test("manual release blocks scheduler dispatch and duplicate releases on the same GPU", async t => {
  const fixture = await engineFixture({ count: 2, location: "local" }); t.after(fixture.close);
  const settings = fixture.store.settings();
  settings.workers[1].deviceIds = [...settings.workers[0].deviceIds]; fixture.store.saveSettings(settings);
  const job = await fixture.queue();
  const client = fixture.engine.client(settings.workers[0]);
  const free = client.freeIfIdle.bind(client);
  let entered = false, resume!: () => void;
  const paused = new Promise<void>(resolve => { resume = resolve; });
  client.freeIfIdle = async () => { entered = true; await paused; return free(); };
  const releasing = fixture.engine.releaseWorkerMemory("worker-0");
  try {
    await until(() => entered);
    assert.deepEqual((await fixture.engine.state(fixture.owner.id)).workers.map(worker => worker.canRelease), [false, false]);
    await assert.rejects(fixture.engine.releaseWorkerMemory("worker-1"), { code: "WORKER_RELEASE_PENDING" });
    await fixture.engine.tick();
    assert.equal(fixture.store.job(job.id).status, "queued");
    assert.deepEqual(fixture.workers.map(worker => worker.state.submissions.length), [0, 0]);
  } finally { resume(); await releasing; }
  assert.deepEqual(fixture.workers.map(worker => worker.state.frees), [1, 0]);
});

test("manual release rejects unknown, unavailable, changed and disabled workers plus setup or shutdown", async t => {
  const fixture = await engineFixture(); t.after(fixture.close);
  await assert.rejects(fixture.engine.releaseWorkerMemory("missing"), { status: 404, code: "WORKER_NOT_FOUND" });
  await assert.rejects(fixture.engine.releaseWorkerMemory("worker-0"), { status: 409, code: "WORKER_UNAVAILABLE" });
  await fixture.engine.refreshWorkers();
  fixture.engine.beginRuntimeSetup();
  assert.equal((await fixture.engine.state(fixture.owner.id)).workers[0].canRelease, false);
  await assert.rejects(fixture.engine.releaseWorkerMemory("worker-0"), { status: 409, code: "RUNTIME_BUSY" });
  fixture.engine.endRuntimeSetup();
  fixture.engine.stopping = true;
  assert.equal((await fixture.engine.state(fixture.owner.id)).workers[0].canRelease, false);
  await assert.rejects(fixture.engine.releaseWorkerMemory("worker-0"), { status: 503, code: "STUDIO_STOPPING" });
  fixture.engine.stopping = false;
  const original = fixture.store.settings();
  for (const update of [{ ...original.workers[0], enabled: false }, { ...original.workers[0], deviceIds: ["changed-gpu"] }, { ...original.workers[0], baseUrl: "http://127.0.0.1:9999" }]) {
    const settings = fixture.store.settings(); settings.workers[0] = update; fixture.store.saveSettings(settings);
    assert.equal((await fixture.engine.state(fixture.owner.id)).workers[0].canRelease, false);
    await assert.rejects(fixture.engine.releaseWorkerMemory("worker-0"), { status: 409, code: "WORKER_UNAVAILABLE" });
  }
  assert.equal(fixture.workers[0].state.frees, 0);
});

test("worker release HTTP requires an owner session, origin and empty body", async t => {
  const fixture = await engineFixture();
  const origin = "http://localhost:4321";
  const runtime = new RuntimeSetup(fixture.store, fixture.engine);
  const server = await createStudioServer({ store: fixture.store, engine: fixture.engine, runtime, allowedOrigins: [origin], setupSecret: "fixture-setup" });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await server.closeOperations(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fixture.close(); });
  await fixture.engine.refreshWorkers();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workers`;
  const cookie = createSession(fixture.store, fixture.owner, false).split(";")[0];
  const token = "fixture-bearer-secret";
  fixture.store.saveApiToken(fixture.owner.id, "Client", digest(token));
  const request = (headers: Record<string, string>, body: unknown = {}, id = "worker-0") => fetch(`${base}/${id}/unload`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const headers = { Cookie: cookie, Origin: origin };
  assert.equal((await request({})).status, 401);
  const bearer = await request({ Authorization: `Bearer ${token}` });
  assert.equal(bearer.status, 403); assert.equal((await bearer.json()).error.code, "SESSION_REQUIRED");
  assert.equal((await request({ Cookie: cookie })).status, 403);
  assert.equal((await request({ ...headers, Origin: "https://untrusted.example" })).status, 403);
  for (const body of [null, [], { unloadAll: true }]) assert.equal((await request(headers, body)).status, 400);
  assert.equal((await request(headers, {}, "%ZZ")).status, 400);
  assert.equal((await request(headers, {}, "missing")).status, 404);
  const status = runtime.status.bind(runtime);
  runtime.status = () => ({ ...status(), busy: true });
  const settingUp = await request(headers);
  assert.equal(settingUp.status, 409); assert.equal((await settingUp.json()).error.code, "RUNTIME_BUSY");
  runtime.status = status;
  assert.equal(fixture.workers[0].state.frees, 0);
  const released = await request(headers);
  assert.equal(released.status, 200); assert.deepEqual(await released.json(), { requested: true });
  assert.equal(fixture.workers[0].state.frees, 1);
  await server.closeOperations();
  const stopping = await request(headers);
  assert.equal(stopping.status, 503); assert.equal((await stopping.json()).error.code, "STUDIO_STOPPING");
  assert.equal(fixture.workers[0].state.frees, 1);
});
