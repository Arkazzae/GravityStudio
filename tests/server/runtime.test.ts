import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeSetup } from "../../apps/server/runtime.ts";
import { createRuntimeDeployment, type RuntimeDeployment } from "../../scripts/runtime-plan.ts";
import { engineFixture, until } from "./helpers/engine-fixture.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }, saved = false) {
  const f = await engineFixture({ count: 0 });
  const initial = f.store.settings();
  for (const model of initial.modelConfigurations) model.enabled = false;
  f.store.saveSettings(initial);
  f.hardware.gpus.forEach((gpu, i) => { gpu.uuid = `GPU-aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, "0")}`; gpu.driverVersion = "580.100.00"; });
  const plan = createRuntimeDeployment(f.hardware, { dataDirectory: f.directory, engine: "docker", gpuIds: f.hardware.gpus.slice(0, 2).map(gpu => gpu.id) });
  let written: RuntimeDeployment | undefined, started: RuntimeDeployment | undefined, smokeCount = 0;
  let block: (() => Promise<void>) | undefined;
  f.engine.refreshWorkers = async () => { for (const worker of f.store.settings().workers) f.engine.workers.set(worker.id, { connected: true, checkedAt: Date.now() }); };
  const manager = new RuntimeSetup(f.store, f.engine, {
    read: async () => { if (saved) return plan; throw Object.assign(new Error("absent"), { code: "ENOENT" }); },
    prepare: async () => ({ plan, preflight: { ready: true, checks: [], supplementalGroupIds: [] } }),
    write: async value => { written = value; return { planFile: "fixture", composeFile: "fixture" }; },
    start: async value => { started = value; await block?.(); },
    smoke: async () => { smokeCount++; return []; },
  });
  t.after(async () => { await manager.close(); await f.close(); });
  return { ...f, plan, manager, written: () => written, started: () => started, smokeCount: () => smokeCount, setBlock(value: () => Promise<void>) { block = value; } };
}

test("setup tests selected GPUs, preserves saved ports and registers selected workers automatically", async t => {
  const f = await fixture(t, true);
  const initial = f.store.settings();
  initial.workers = [{ id: f.plan.workers[0].id, baseUrl: f.plan.workers[0].baseUrl, name: "First GPU", deviceIds: [f.plan.workers[0].gpuId], enabled: true, location: "local", maxConcurrentJobs: 1 }];
  initial.modelConfigurations[0].enabled = true;
  initial.modelConfigurations[0].workerIds = [f.plan.workers[0].id];
  f.store.saveSettings(initial);
  const result = f.manager.start({ gpuIds: [f.plan.workers[1].gpuId] });
  assert.equal(result.busy, true);
  await until(() => !f.manager.status().busy);
  assert.equal(f.manager.status().phase, "ready", f.manager.status().error ?? "");
  assert.equal(f.started()!.workers.length, 1);
  assert.equal(f.started()!.workers[0].baseUrl, f.plan.workers[1].baseUrl);
  assert.equal(f.written()!.workers.length, 2);
  assert.equal(f.smokeCount(), 1);
  assert.deepEqual(f.store.settings().workers.map(worker => worker.enabled), [false, true]);
  assert.deepEqual(f.store.settings().modelConfigurations[0].workerIds, [f.plan.workers[1].id]);
  assert.equal(f.engine.runtimeSetupActive, false);
  assert.equal(f.store.metadata<{ phase: string }>("runtime-setup")?.phase, "ready");
});

test("runtime setup prevents overlapping setup, settings races and new generation submissions", async t => {
  const f = await fixture(t);
  let release!: () => void;
  f.setBlock(() => new Promise<void>(resolve => { release = resolve; }));
  f.manager.start({ gpuIds: f.plan.workers.map(worker => worker.gpuId) });
  await until(() => !!release);
  assert.throws(() => f.manager.start({ gpuIds: ["gpu-0"] }), /already running/);
  await assert.rejects(f.engine.submit(f.owner.id, { modelId: "sdxl-base", prompt: "A cup" }, "runtime-busy-test"), /being set up/);
  release();
  await until(() => !f.manager.status().busy);
  assert.equal(f.manager.status().phase, "ready");
});

test("invalid selections do not execute host commands and a failed setup can be retried", async t => {
  const f = await fixture(t);
  assert.throws(() => f.manager.start({ gpuIds: [] }), /at least one/);
  assert.throws(() => f.manager.start({ gpuIds: ["gpu-0", "gpu-0"] }), /duplicates/);
  assert.throws(() => f.manager.start({ gpuIds: ["gpu-0"], command: "anything" }), /Choose/);
  f.manager.start({ gpuIds: ["missing"] });
  await until(() => !f.manager.status().busy);
  assert.equal(f.manager.status().phase, "failed");
  assert.equal(f.started(), undefined);
  assert.equal(f.engine.runtimeSetupActive, false);
  f.manager.start({ gpuIds: ["gpu-0"] });
  await until(() => !f.manager.status().busy);
  assert.equal(f.manager.status().phase, "ready");
});

test("active and interrupted generation records block GPU reconfiguration", async t => {
  const f = await fixture(t);
  f.store.createJob(f.owner.id, { modelId: "sdxl-base", prompt: "A cup" }, {}, [], "SDXL", {}, "existing-job", "fixture");
  assert.throws(() => f.manager.start({ gpuIds: ["gpu-0"] }), /Finish or cancel/);
  assert.equal(f.engine.runtimeSetupActive, false);
  assert.equal(f.started(), undefined);
});

test("server restart marks unfinished setup interrupted and allows a fresh retry", async t => {
  const f = await fixture(t);
  f.store.setMetadata("runtime-setup", { ...f.manager.status(), phase: "building", busy: true });
  const restored = new RuntimeSetup(f.store, f.engine);
  assert.equal(restored.status().phase, "failed");
  assert.equal(restored.status().busy, false);
  assert.match(restored.status().message, /restart/);
  await restored.close();
});

test("worker discovery started before GPU changes cannot replace the new configuration", async t => {
  const f = await engineFixture();
  t.after(() => f.close());
  const settings = f.store.settings();
  const client = f.engine.client(settings.workers[0]);
  const health = client.health.bind(client);
  let release!: () => void;
  let first = true;
  client.health = async () => { if (first) { first = false; await new Promise<void>(resolve => { release = resolve; }); } return health(); };
  const oldRefresh = f.engine.refreshWorkers(true);
  await until(() => !!release);
  const oldId = settings.workers[0].id;
  settings.workers[0].id = "replacement-worker";
  for (const model of settings.modelConfigurations) model.workerIds = model.workerIds.map(id => id === oldId ? "replacement-worker" : id);
  f.store.saveSettings(settings);
  f.engine.invalidateWorkers();
  const newRefresh = f.engine.refreshWorkers(true);
  release();
  await Promise.all([oldRefresh, newRefresh]);
  assert.equal(f.engine.workers.has(oldId), false);
  assert.equal(f.engine.workers.get("replacement-worker")?.connected, true);
});
