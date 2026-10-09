import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { completed, PNG } from "../inference/fake-comfy.ts";
import { engineFixture, GiB, until } from "./helpers/engine-fixture.ts";
import type { ExecutionSnapshot, WorkflowGraph } from "../../packages/inference/index.ts";

const secondModel = "wai-illustrious-v17";
async function warmBothWorkers(fixture: Awaited<ReturnType<typeof engineFixture>>) {
  const settings = fixture.store.settings();
  const model = settings.modelConfigurations.find(item => item.modelId === secondModel)!;
  model.enabled = true; model.workerIds = settings.workers.map(worker => worker.id);
  model.memory = { ramBytes: 8 * GiB, vramBytes: 6 * GiB, source: "estimate" };
  fixture.store.saveSettings(settings);
  await fixture.engine.catalog();
  assert.deepEqual(fixture.workers.map(worker => worker.state.submissions.length), [0, 0], "Catalog discovery does not preload models");
  const first = await fixture.queue(); const second = await fixture.queue({ modelId: secondModel });
  await fixture.engine.tick();
  await until(() => fixture.store.job(first.id).status === "running" && fixture.store.job(second.id).status === "running");
  assert.equal(fixture.store.job(first.id).workerId, "worker-0");
  assert.equal(fixture.store.job(second.id).workerId, "worker-1");
  fixture.complete(0, first.id); fixture.complete(1, second.id);
  await until(() => fixture.store.job(first.id).status === "succeeded" && fixture.store.job(second.id).status === "succeeded");
  return { first, second };
}

test("catalog installation reflects complete configured files independently of GPU readiness", async t => {
  const fixture = await engineFixture({ count: 0 }); t.after(fixture.close);
  const qwen = async () => (await fixture.engine.catalog()).models.find(model => model.id === "qwen-image-2.1")!;
  const missing = await qwen();
  assert.equal(missing.installed, false);
  const paths = missing.artifacts.map(artifact => join(fixture.directory, "models", artifact.folder, artifact.filename));
  for (let index = 0; index < paths.length; index++) {
    await mkdir(join(paths[index], ".."), { recursive: true });
    await writeFile(paths[index], index === paths.length - 1 ? "" : "fixture model bytes");
  }
  assert.equal((await qwen()).installed, false, "an empty required file is not an installed model");
  await rm(paths[2]);
  await symlink(paths[0], paths[2]);
  assert.equal((await qwen()).installed, false, "symlinks are treated like the model library's installed-file check");
  await rm(paths[2]);
  await writeFile(paths[2], "fixture model bytes");
  const complete = await qwen();
  assert.equal(complete.installed, true);
  assert.equal(complete.ready, false, "downloaded files stay listed even with no running GPU worker");
  await fixture.restart();
  assert.equal((await qwen()).installed, true, "local installation does not depend on an in-memory discovery cache");
  const settings = fixture.store.settings();
  settings.modelConfigurations.find(model => model.modelId === missing.id)!.artifacts.vae = "different-vae.safetensors";
  fixture.store.saveSettings(settings);
  assert.equal((await qwen()).installed, false, "installation checks the user's configured filenames");
});

test("catalog keeps a remote worker's last known files offline without transferring evidence to another endpoint", async t => {
  const fixture = await engineFixture(); t.after(fixture.close);
  const sdxl = async () => (await fixture.engine.catalog()).models.find(model => model.id === "sdxl-base")!;
  assert.equal((await sdxl()).installed, true);
  let settings = fixture.store.settings();
  fixture.engine.client(settings.workers[0]).health = async () => ({ healthy: false, error: "Fixture GPU offline" });
  await fixture.engine.refreshWorkers(true);
  const offline = await sdxl();
  assert.equal(offline.ready, false);
  assert.equal(offline.installed, true, "offline is not evidence that a downloaded checkpoint disappeared");
  await assert.rejects(fixture.queue(), { code: "MODEL_UNAVAILABLE", message: "Fixture GPU offline" });
  settings.policy.maxConcurrentJobs = 2;
  settings = fixture.store.saveSettings(settings);
  fixture.engine.invalidateWorkers();
  assert.equal(fixture.engine.workers.get(settings.workers[0].id)?.connected, false);
  assert.equal(fixture.engine.workers.get(settings.workers[0].id)?.checkedAt, 0);
  assert.equal((await sdxl()).installed, true, "saving generation policy preserves installed files on the same offline worker");
  assert.equal((await sdxl()).ready, false, "retained inventory does not mark the worker connected");
  settings.workers[0].baseUrl += "/replacement";
  fixture.store.saveSettings(settings);
  fixture.engine.invalidateWorkers();
  assert.equal(fixture.engine.workers.has(settings.workers[0].id), false, "a changed identity drops its cached inventory");
  fixture.engine.client(settings.workers[0]).health = async () => ({ healthy: false, error: "Replacement GPU offline" });
  assert.equal((await sdxl()).installed, false, "a changed endpoint cannot inherit cached artifact availability");
  await fixture.restart();
  fixture.engine.client(settings.workers[0]).health = async () => ({ healthy: false, error: "Fixture GPU offline" });
  assert.equal((await sdxl()).installed, false, "a cold offline worker without local files provides no installation evidence");
});

test("generation through Engine, SQLite and Comfy HTTP saves the actual output once", async t => {
  const fixture = await engineFixture(); t.after(fixture.close);
  const key = "same-generation-key";
  const job = await fixture.queue({}, key);
  assert.equal((await fixture.queue({}, key)).id, job.id);
  await fixture.engine.tick();
  await until(() => fixture.store.job(job.id).status === "running", "accepted generation");
  await until(() => fixture.store.job(job.id).stage.startsWith("Sampling step"), "worker progress");
  assert.equal(fixture.store.job(job.id).progress, null);
  assert.equal((await fixture.queue({}, key)).id, job.id);
  fixture.complete(0, job.id);
  await until(() => fixture.store.job(job.id).status === "succeeded", "saved output");
  const saved = fixture.store.job(job.id);
  assert.equal(saved.outputs.length, 1);
  const output = fixture.store.output(job.id, saved.outputs[0].id, fixture.owner.id);
  assert.deepEqual(await readFile(output.path!), Buffer.from(PNG));
  assert.equal(output.width, 1); assert.equal(output.height, 1);
  assert.equal(fixture.workers[0].state.submissions.length, 1);
  await assert.rejects(fixture.queue({ prompt: "A different request" }, key), { code: "IDEMPOTENCY_CONFLICT" });
  await fixture.engine.reconcile(); await fixture.engine.tick();
  assert.equal(fixture.store.job(job.id).status, "succeeded");
  assert.equal(fixture.workers[0].state.submissions.length, 1);
});

test("a restarted server observes its saved remote prompt without submitting it again", async t => {
  const fixture = await engineFixture(); t.after(fixture.close);
  fixture.workers[0].state.postBehavior = "legacy-id";
  const job = await fixture.queue(); await fixture.engine.tick();
  await until(() => fixture.store.job(job.id).status === "running");
  assert.equal(fixture.store.job(job.id).promptId, "legacy-prompt-id");
  await fixture.restart();
  fixture.complete(0, "legacy-prompt-id");
  await fixture.engine.reconcile();
  await until(() => fixture.store.job(job.id).status === "succeeded");
  assert.equal(fixture.workers[0].state.submissions.length, 1);
});

test("a corrupt completed image fails and releases its lease instead of retrying forever", async t => {
  const fixture = await engineFixture({ maxConcurrent: 1 }); t.after(fixture.close);
  fixture.workers[0].state.outputBytes = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=", "base64"));
  const job = await fixture.queue(); await fixture.engine.tick();
  await until(() => fixture.store.job(job.id).status === "running");
  fixture.complete(0, job.id);
  await until(() => fixture.store.job(job.id).status === "failed" && !fixture.engine.flights.has(job.id));
  assert.equal(fixture.store.job(job.id).stage, "Worker returned an invalid image");
  assert.deepEqual(fixture.store.job(job.id).outputs, []);
  assert.equal(fixture.store.activeJobs().length, 0);
  const reads = fixture.workers[0].state.outputReads;
  await fixture.engine.reconcile();
  assert.equal(fixture.workers[0].state.outputReads, reads);
  const next = await fixture.queue({ prompt: "After the corrupt result" }); await fixture.engine.tick();
  await until(() => fixture.store.job(next.id).status === "running");
  assert.equal(fixture.workers[0].state.submissions.length, 2);
});

test("invalid output downloads fail, while a temporary download failure remains recoverable", async t => {
  for (const kind of ["unsupported", "oversized", "unavailable"] as const) await t.test(kind, async t => {
    const fixture = await engineFixture(); t.after(fixture.close);
    const previous = fixture.workers[0].state.responseOverride;
    fixture.workers[0].state.responseOverride = path => path !== "/view" ? previous?.(path) : kind === "oversized"
      ? { headers: { "Content-Length": String(65 * 1024 ** 2) }, body: "" }
      : { status: kind === "unavailable" ? 503 : 200, body: "Not an image" };
    const job = await fixture.queue(); await fixture.engine.tick();
    await until(() => fixture.store.job(job.id).status === "running");
    fixture.complete(0, job.id);
    await until(() => fixture.store.job(job.id).status === (kind === "unavailable" ? "interrupted" : "failed") && !fixture.engine.flights.has(job.id));
    assert.equal(fixture.store.activeJobs().length, kind === "unavailable" ? 1 : 0);
    assert.equal(fixture.workers[0].state.submissions.length, 1);
  });
});

test("uncertain submission keeps its lease, periodically reconciles and never replays POST", async t => {
  const fixture = await engineFixture({ maxConcurrent: 1 }); t.after(fixture.close);
  fixture.workers[0].state.postBehavior = "drop-before-accept";
  const job = await fixture.queue(); await fixture.engine.tick();
  await until(() => fixture.store.job(job.id).status === "interrupted");
  const next = await fixture.queue({ prompt: "The next image" });
  await fixture.engine.tick();
  assert.equal(fixture.store.job(next.id).status, "queued");
  fixture.engine.cancel(fixture.owner.id, next.id);
  await fixture.engine.start();
  await delay(180);
  assert.equal(fixture.workers[0].state.submissions.length, 1);
  assert.equal(fixture.store.job(job.id).status, "interrupted");
  const searches = fixture.workers[0].state.requests.filter(request => request.path === "/history").length;
  assert(searches >= 2 && searches < 15, `expected bounded recovery polling, received ${searches}`);
  const submitted = fixture.workers[0].state.submissions[0];
  fixture.workers[0].state.history["late-acknowledgment"] = completed([1, "late-acknowledgment", submitted.prompt, submitted.extra_data, ["output"]]);
  await until(() => fixture.store.job(job.id).status === "succeeded", "late completion reconciliation");
  assert.equal(fixture.workers[0].state.submissions.length, 1);
  assert.equal(fixture.store.job(next.id).status, "cancelled");
});

test("an actual ComfyUI workflow rejection fails rather than holding an uncertain lease", async t => {
  const fixture = await engineFixture(); t.after(fixture.close);
  fixture.workers[0].state.postBehavior = "reject";
  const job = await fixture.queue(); await fixture.engine.tick();
  await until(() => fixture.store.job(job.id).status === "failed");
  assert.equal(fixture.store.job(job.id).stage, "Workflow rejected");
  assert(!fixture.store.job(job.id).error?.includes("Private filesystem"));
  assert.equal(fixture.store.activeJobs().length, 0);
});

test("remote admission rejects impossible per-GPU capacity without pooling another GPU", async t => {
  const fixture = await engineFixture(); t.after(fixture.close);
  const settings = fixture.store.settings(); settings.workers[0].deviceIds = ["cuda:0"]; fixture.store.saveSettings(settings);
  fixture.stats[0].devices = [
    { name: "Small", type: "cuda", index: 0, vram_total: 4 * GiB, vram_free: 4 * GiB },
    { name: "Large", type: "cuda", index: 1, vram_total: 80 * GiB, vram_free: 80 * GiB },
  ];
  const job = await fixture.queue(); await fixture.engine.tick();
  assert.equal(fixture.store.job(job.id).status, "failed");
  assert.match(fixture.store.job(job.id).error!, /assigned GPU/);
  assert.equal(fixture.workers[0].state.submissions.length, 0);
  assert.equal(fixture.workers[0].state.frees, 0);
});

test("remote total RAM shortfall fails, while current RAM pressure waits", async t => {
  const fixture = await engineFixture(); t.after(fixture.close);
  fixture.stats[0].system.ram_total = 4 * GiB; fixture.stats[0].system.ram_free = 4 * GiB;
  const impossible = await fixture.queue(); await fixture.engine.tick();
  assert.equal(fixture.store.job(impossible.id).status, "failed");
  fixture.stats[0].system.ram_total = 64 * GiB;
  const waiting = await fixture.queue(); await fixture.engine.tick();
  assert.equal(fixture.store.job(waiting.id).status, "queued");
  assert.match(fixture.store.job(waiting.id).stage, /RAM|memory/);
  assert.equal(fixture.workers[0].state.submissions.length, 0);
  fixture.stats[0].system.ram_free = 64 * GiB; await delay(1050); await fixture.engine.tick();
  await until(() => fixture.store.job(waiting.id).status === "running");
});

test("idle cached models are released safely and admission uses a fresh measurement", async t => {
  const fixture = await engineFixture({ location: "local" }); t.after(fixture.close);
  fixture.hardware.gpus[0].memory.usedBytes = 13 * GiB;
  const original = fixture.workers[0].state.responseOverride;
  fixture.workers[0].state.responseOverride = path => {
    if (path === "/free") fixture.hardware.gpus[0].memory.usedBytes = 0;
    return original?.(path);
  };
  const job = await fixture.queue(); await fixture.engine.tick();
  assert.equal(fixture.store.job(job.id).status, "queued", "The /free acknowledgement does not immediately release the endpoint for dispatch");
  await delay(1050); await fixture.engine.tick();
  await until(() => fixture.store.job(job.id).status === "running");
  assert.equal(fixture.workers[0].state.frees, 1);
  assert.equal(fixture.workers[0].state.submissions.length, 1);
});

test("external GPU usage stays queued when idle release cannot recover enough memory", async t => {
  const fixture = await engineFixture(); t.after(fixture.close);
  fixture.stats[0].devices[0].vram_free = 2 * GiB;
  const job = await fixture.queue(); await fixture.engine.tick(); await fixture.engine.tick();
  assert.equal(fixture.store.job(job.id).status, "queued");
  assert.equal(fixture.workers[0].state.frees, 1);
  assert.equal(fixture.workers[0].state.submissions.length, 0);
  fixture.stats[0].devices[0].vram_free = 16 * GiB; await delay(1050); await fixture.engine.tick();
  await until(() => fixture.store.job(job.id).status === "running");
});

test("different GPUs on one remote host share a RAM reservation budget", async t => {
  const fixture = await engineFixture({ count: 2 }); t.after(fixture.close);
  for (const stats of fixture.stats) { stats.system.ram_total = 16 * GiB; stats.system.ram_free = 16 * GiB; }
  const first = await fixture.queue(); const second = await fixture.queue({ prompt: "Second" });
  await fixture.engine.tick();
  await until(() => fixture.store.job(first.id).status === "running");
  assert.equal(fixture.store.job(second.id).status, "queued");
  assert.equal(fixture.workers[1].state.submissions.length, 0);
  fixture.complete(0, first.id);
  await until(() => fixture.store.job(first.id).status === "succeeded");
  await delay(1050); await fixture.engine.tick(); await until(() => fixture.store.job(second.id).status === "running");
});

test("an unidentified remote GPU serializes with every other endpoint on its host", async t => {
  const fixture = await engineFixture({ count: 2 }); t.after(fixture.close);
  const settings = fixture.store.settings(); settings.workers[0].deviceIds = []; fixture.store.saveSettings(settings);
  const first = await fixture.queue(); const second = await fixture.queue({ prompt: "Second" });
  await fixture.engine.tick(); await until(() => fixture.store.job(first.id).status === "running");
  assert.equal(fixture.store.job(second.id).status, "queued");
  assert.equal(fixture.workers[1].state.submissions.length, 0);
});

test("two workers on a three-GPU host execute two jobs once and reserve only assigned GPUs", async t => {
  const fixture = await engineFixture({ count: 2, location: "local" }); t.after(fixture.close);
  const first = await fixture.queue(); const second = await fixture.queue({ prompt: "Second" }); const third = await fixture.queue({ prompt: "Third" });
  await Promise.all([fixture.engine.tick(), fixture.engine.tick()]);
  await until(() => fixture.store.job(first.id).status === "running" && fixture.store.job(second.id).status === "running");
  assert.equal(fixture.store.job(first.id).workerId, "worker-0");
  assert.equal(fixture.store.job(second.id).workerId, "worker-1");
  assert.equal(fixture.store.job(third.id).status, "queued");
  assert.deepEqual(fixture.workers.map(worker => worker.state.submissions.length), [1, 1]);
  fixture.complete(0, first.id); await until(() => fixture.store.job(first.id).status === "succeeded");
  await Promise.all([fixture.engine.tick(), fixture.engine.tick()]);
  await until(() => fixture.store.job(third.id).status === "running");
  assert.deepEqual(fixture.workers.map(worker => worker.state.submissions.length), [2, 1]);
});

test("cancellation during awaited telemetry cannot resurrect or submit a queued job", async t => {
  const fixture = await engineFixture({ location: "local" }); t.after(fixture.close);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  fixture.beforeDetect = async () => { entered(); await blocked; };
  const job = await fixture.queue(); const tick = fixture.engine.tick();
  await started;
  fixture.engine.cancel(fixture.owner.id, job.id);
  release(); await tick;
  assert.equal(fixture.store.job(job.id).status, "cancelled");
  assert.equal(fixture.workers[0].state.submissions.length, 0);
});

test("the configured idle timeout unloads a completed worker without stopping its process", async t => {
  const fixture = await engineFixture(); t.after(fixture.close);
  const settings = fixture.store.settings(); settings.policy.idleUnloadSeconds = 1; fixture.store.saveSettings(settings);
  const job = await fixture.queue(); await fixture.engine.start();
  await until(() => fixture.store.job(job.id).status === "running");
  fixture.complete(0, job.id);
  await until(() => fixture.store.job(job.id).status === "succeeded");
  await until(() => fixture.workers[0].state.frees === 1, "idle model release");
  assert.equal(fixture.store.job(job.id).status, "succeeded");
  assert.equal(fixture.workers[0].state.submissions.length, 1);
});

test("different models run in parallel, then prefer their previous worker without waiting for a busy GPU", async t => {
  const fixture = await engineFixture({ count: 2, location: "local" }); t.after(fixture.close);
  await warmBothWorkers(fixture);
  assert.deepEqual(fixture.workers.map(worker => (worker.state.submissions[0].prompt as WorkflowGraph).checkpoint.inputs.ckpt_name), ["sd_xl_base_1.0.safetensors", "waiIllustriousSDXL_v170.safetensors"]);
  const warm = await fixture.queue({ modelId: secondModel, prompt: "A new composition", seed: 987 });
  await fixture.engine.tick(); await until(() => fixture.store.job(warm.id).status === "running");
  assert.equal(fixture.store.job(warm.id).workerId, "worker-1", "Prompt and seed changes do not discard model affinity");
  const concurrent = await fixture.queue({ modelId: secondModel, prompt: "Use the other GPU while the preferred one is busy" });
  await fixture.engine.tick(); await until(() => fixture.store.job(concurrent.id).status === "running");
  assert.equal(fixture.store.job(concurrent.id).workerId, "worker-0");
  assert.deepEqual(fixture.workers.map(worker => worker.state.frees), [0, 0]);
});

test("admission checks the other GPU before evicting an idle candidate's cache", async t => {
  const fixture = await engineFixture({ count: 2, location: "local" }); t.after(fixture.close);
  fixture.hardware.gpus[0].memory.usedBytes = 13 * GiB;
  const previous = fixture.workers[0].state.responseOverride;
  fixture.workers[0].state.responseOverride = path => { if (path === "/free") fixture.hardware.gpus[0].memory.usedBytes = 0; return previous?.(path); };
  const job = await fixture.queue(); await fixture.engine.tick();
  await until(() => fixture.store.job(job.id).status === "running");
  assert.equal(fixture.store.job(job.id).workerId, "worker-1");
  assert.deepEqual(fixture.workers.map(worker => worker.state.frees), [0, 0], "An already available GPU wins before any cache release");
});

test("affinity cannot bypass a memory budget and is cleared when its worker releases models", async t => {
  const fixture = await engineFixture({ count: 2 }); t.after(fixture.close);
  await warmBothWorkers(fixture);
  let settings = fixture.store.settings(); settings.modelConfigurations.find(item => item.modelId === secondModel)!.workerIds = ["worker-1"]; fixture.store.saveSettings(settings);
  fixture.stats[1].devices[0].vram_free = 2 * GiB;
  const blocked = await fixture.queue({ modelId: secondModel }); await fixture.engine.tick();
  assert.equal(fixture.store.job(blocked.id).status, "queued", "Previously used weights are not evidence of free or owned VRAM");
  assert.equal(fixture.workers[1].state.frees, 1);
  assert.equal(fixture.workers[1].state.submissions.length, 1);
  fixture.engine.cancel(fixture.owner.id, blocked.id);
  fixture.stats[1].devices[0].vram_free = 16 * GiB;
  settings = fixture.store.settings(); settings.modelConfigurations.find(item => item.modelId === secondModel)!.workerIds = ["worker-0", "worker-1"]; fixture.store.saveSettings(settings);
  const next = await fixture.queue({ modelId: secondModel }); await fixture.engine.tick();
  await until(() => fixture.store.job(next.id).status === "running");
  assert.equal(fixture.store.job(next.id).workerId, "worker-0", "A freed worker has no retained affinity");
});

test("queued model artifacts and budgets stay immutable, while new artifacts do not inherit old affinity", async t => {
  const fixture = await engineFixture({ count: 2 }); t.after(fixture.close);
  await warmBothWorkers(fixture);
  const queued = await fixture.queue({ modelId: secondModel });
  const settings = fixture.store.settings();
  const configuration = settings.modelConfigurations.find(item => item.modelId === secondModel)!;
  configuration.artifacts.checkpoint = "sd_xl_base_1.0.safetensors"; configuration.memory.vramBytes = 7 * GiB;
  fixture.store.saveSettings(settings);
  await fixture.engine.tick(); await until(() => fixture.store.job(queued.id).status === "running");
  assert.equal(fixture.store.job(queued.id).workerId, "worker-1");
  assert.equal(fixture.store.job(queued.id).placements[0].memory.vramBytes, 6 * GiB);
  assert.equal((fixture.store.job(queued.id).snapshot as ExecutionSnapshot).graph.checkpoint.inputs.ckpt_name, "waiIllustriousSDXL_v170.safetensors");
  fixture.complete(1, queued.id); await until(() => fixture.store.job(queued.id).status === "succeeded");
  const changed = await fixture.queue({ modelId: secondModel }); await fixture.engine.tick();
  await until(() => fixture.store.job(changed.id).status === "running");
  assert.equal(fixture.store.job(changed.id).workerId, "worker-0");
  assert.equal((fixture.workers[0].state.submissions.at(-1)!.prompt as WorkflowGraph).checkpoint.inputs.ckpt_name, "sd_xl_base_1.0.safetensors");
  assert.equal(fixture.store.job(changed.id).placements[0].memory.vramBytes, 7 * GiB);
});

test("disconnects, changed endpoints and failed loads invalidate affinity", async t => {
  for (const cause of ["disconnect", "endpoint", "failed-load"] as const) await t.test(cause, async t => {
    const fixture = await engineFixture({ count: 2 }); t.after(fixture.close);
    await warmBothWorkers(fixture);
    if (cause === "disconnect") {
      const previous = fixture.workers[1].state.responseOverride;
      fixture.workers[1].state.responseOverride = path => path === "/system_stats" ? { status: 503, body: "Unavailable" } : previous?.(path);
      await fixture.engine.refreshWorkers(true);
      fixture.workers[1].state.responseOverride = previous;
      await fixture.engine.refreshWorkers(true);
    } else if (cause === "endpoint") {
      const settings = fixture.store.settings();
      [settings.workers[0].baseUrl, settings.workers[1].baseUrl] = [settings.workers[1].baseUrl, settings.workers[0].baseUrl];
      fixture.store.saveSettings(settings);
    } else {
      fixture.workers[1].state.postBehavior = "reject";
      const rejected = await fixture.queue({ modelId: secondModel }); await fixture.engine.tick();
      await until(() => fixture.store.job(rejected.id).status === "failed");
      fixture.workers[1].state.postBehavior = "normal";
    }
    const next = await fixture.queue({ modelId: secondModel }); await fixture.engine.tick();
    await until(() => fixture.store.job(next.id).status === "running");
    assert.equal(fixture.store.job(next.id).workerId, "worker-0");
  });
});

test("local host RAM pressure can reclaim an idle sibling even with no idle timeout", async t => {
  const fixture = await engineFixture({ count: 2, location: "local" }); t.after(fixture.close);
  await warmBothWorkers(fixture);
  const settings = fixture.store.settings(); settings.modelConfigurations.find(item => item.modelId === "sdxl-base")!.workerIds = ["worker-0"]; fixture.store.saveSettings(settings);
  assert.equal(settings.policy.idleUnloadSeconds, 0);
  fixture.hardware.host.memory.availableBytes = 9 * GiB;
  const previous = fixture.workers[1].state.responseOverride;
  fixture.workers[1].state.responseOverride = path => { if (path === "/free") fixture.hardware.host.memory.availableBytes = 64 * GiB; return previous?.(path); };
  const job = await fixture.queue(); await fixture.engine.tick();
  assert.equal(fixture.store.job(job.id).status, "queued");
  assert.deepEqual(fixture.workers.map(worker => worker.state.frees), [1, 0]);
  await delay(1050); await fixture.engine.tick();
  await until(() => fixture.store.job(job.id).status === "running");
  assert.equal(fixture.store.job(job.id).workerId, "worker-0");
  assert.deepEqual(fixture.workers.map(worker => worker.state.frees), [1, 1]);
  assert.equal(fixture.workers[1].state.submissions.length, 1, "The sibling releases cache without receiving the constrained job");
});

test("host RAM pressure never evicts an active sibling's model", async t => {
  const fixture = await engineFixture({ count: 2, location: "local" }); t.after(fixture.close);
  await warmBothWorkers(fixture);
  const settings = fixture.store.settings();
  settings.modelConfigurations.find(item => item.modelId === "sdxl-base")!.workerIds = ["worker-0"];
  settings.modelConfigurations.find(item => item.modelId === secondModel)!.workerIds = ["worker-1"];
  fixture.store.saveSettings(settings);
  const active = await fixture.queue({ modelId: secondModel }); await fixture.engine.tick();
  await until(() => fixture.store.job(active.id).status === "running");
  fixture.hardware.host.memory.availableBytes = 9 * GiB;
  const blocked = await fixture.queue(); await fixture.engine.tick();
  await delay(1050); await fixture.engine.tick();
  assert.equal(fixture.store.job(blocked.id).status, "queued");
  assert.equal(fixture.store.job(active.id).status, "running");
  assert.equal(fixture.workers[1].state.frees, 0);
});

test("an acknowledged but unfinished cache release does not evict the other GPUs for queued jobs", async t => {
  const fixture = await engineFixture({ count: 3, location: "local" }); t.after(fixture.close);
  const previous: Awaited<ReturnType<typeof fixture.queue>>[] = [];
  for (let index = 0; index < 3; index++) previous.push(await fixture.queue());
  await fixture.engine.tick(); await until(() => previous.every(job => fixture.store.job(job.id).status === "running"));
  previous.forEach(job => fixture.complete(Number(fixture.store.job(job.id).workerId!.split("-")[1]), job.id));
  await until(() => previous.every(job => fixture.store.job(job.id).status === "succeeded"));
  const settings = fixture.store.settings(); settings.modelConfigurations.find(item => item.modelId === "sdxl-base")!.workerIds = ["worker-0"]; fixture.store.saveSettings(settings);
  fixture.hardware.host.memory.availableBytes = 9 * GiB;
  const first = await fixture.queue(), second = await fixture.queue();
  await fixture.engine.tick();
  assert.equal(fixture.store.job(first.id).status, "queued");
  assert.equal(fixture.store.job(second.id).status, "queued");
  assert.deepEqual(fixture.workers.map(worker => worker.state.frees), [1, 0, 0], "The acknowledgement is not evidence that GC finished");
  // The accepted /free finishes after its HTTP response and the original tick.
  fixture.hardware.host.memory.availableBytes = 64 * GiB;
  await fixture.engine.tick();
  assert.equal(fixture.store.job(first.id).status, "queued", "The releasing GPU remains unavailable until the next polling interval");
  await delay(1050);
  await fixture.engine.tick(); await until(() => fixture.store.job(first.id).status === "running");
  assert.deepEqual(fixture.workers.map(worker => worker.state.frees), [1, 0, 0], "Fresh measurements admit the job without dropping sibling caches");
});

test("host reclaim respects a preparing process even after its GPU binding changes", async t => {
  const fixture = await engineFixture({ count: 2, location: "local" }); t.after(fixture.close);
  await warmBothWorkers(fixture);
  let settings = fixture.store.settings();
  settings.workers[0].deviceIds = ["gpu-1"];
  settings.modelConfigurations.find(item => item.modelId === "sdxl-base")!.workerIds = ["worker-1"];
  settings.modelConfigurations.find(item => item.modelId === secondModel)!.workerIds = ["worker-0"];
  fixture.store.saveSettings(settings);
  const active = await fixture.queue({ modelId: secondModel });
  const client = fixture.engine.client(settings.workers[0]);
  const original = client.discover.bind(client);
  let entered = false, release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  client.discover = async () => { entered = true; await paused; return original(); };
  try {
    await fixture.engine.tick(); await until(() => entered, "preparing discovery");
    client.discover = original;
    assert.equal(fixture.store.job(active.id).status, "preparing");
    assert.equal(fixture.workers[0].state.pending.length, 0, "Comfy's queue cannot yet reveal the preparing Studio job");
    settings = fixture.store.settings(); settings.workers[0].deviceIds = ["gpu-0"]; fixture.store.saveSettings(settings);
    fixture.hardware.host.memory.availableBytes = 9 * GiB;
    const blocked = await fixture.queue(); await fixture.engine.tick();
    await delay(1050); await fixture.engine.tick();
    assert.equal(fixture.store.job(blocked.id).status, "queued");
    assert.equal(fixture.workers[0].state.frees, 0, "Historical idle GPU metadata does not make an active endpoint safe to unload");
  } finally { client.discover = original; release(); }
});

test("idle release blocks another endpoint bound to the same GPU", async t => {
  const fixture = await engineFixture({ count: 2 }); t.after(fixture.close);
  await warmBothWorkers(fixture);
  const settings = fixture.store.settings(); settings.policy.idleUnloadSeconds = 1;
  settings.modelConfigurations.find(item => item.modelId === secondModel)!.workerIds = ["worker-1"];
  fixture.store.saveSettings(settings);
  const client = fixture.engine.client(settings.workers[0]);
  const original = client.freeIfIdle.bind(client);
  let entered = false, release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  client.freeIfIdle = async () => { entered = true; await paused; return original(); };
  let waiting!: Awaited<ReturnType<typeof fixture.queue>>;
  try {
    await delay(1050); await fixture.engine.start(); await until(() => entered, "idle release");
    const updated = fixture.store.settings(); updated.workers[1].deviceIds = [...updated.workers[0].deviceIds]; fixture.store.saveSettings(updated);
    waiting = await fixture.queue({ modelId: secondModel }); await fixture.engine.tick();
    assert.equal(fixture.store.job(waiting.id).status, "queued");
    assert.equal(fixture.workers[1].state.submissions.length, 1);
  } finally { release(); }
  await until(() => fixture.store.job(waiting.id).status === "running");
});

test("idle release blocks dispatch on its endpoint and rechecks siblings before unloading them", async t => {
  const fixture = await engineFixture({ count: 2 }); t.after(fixture.close);
  await warmBothWorkers(fixture);
  const settings = fixture.store.settings(); settings.policy.idleUnloadSeconds = 1;
  settings.modelConfigurations.find(item => item.modelId === "sdxl-base")!.workerIds = ["worker-0"];
  settings.modelConfigurations.find(item => item.modelId === secondModel)!.workerIds = ["worker-1"];
  fixture.store.saveSettings(settings);
  const client = fixture.engine.client(settings.workers[0]);
  const original = client.freeIfIdle.bind(client);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  client.freeIfIdle = async () => { entered(); await paused; return original(); };
  await delay(1050); await fixture.engine.start();
  await started;
  let waiting!: Awaited<ReturnType<typeof fixture.queue>>;
  try {
    waiting = await fixture.queue(); const sibling = await fixture.queue({ modelId: secondModel });
    await fixture.engine.tick(); await until(() => fixture.store.job(sibling.id).status === "running");
    assert.equal(fixture.store.job(waiting.id).status, "queued", "No job is dispatched while its worker is unloading");
    assert.equal(fixture.workers[0].state.submissions.length, 1);
  } finally { release(); }
  await until(() => fixture.store.job(waiting.id).status === "running");
  assert.deepEqual(fixture.workers.map(worker => worker.state.frees), [1, 0], "The second worker's new job invalidates the earlier idle decision");
});
