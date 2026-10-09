import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { completed, PNG } from "../inference/fake-comfy.ts";
import { engineFixture, GiB, until } from "./helpers/engine-fixture.ts";

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
  assert.deepEqual(await readFile(output.path), Buffer.from(PNG));
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
  fixture.stats[0].system.ram_free = 64 * GiB; await fixture.engine.tick();
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
  fixture.stats[0].devices[0].vram_free = 16 * GiB; await fixture.engine.tick();
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
  await fixture.engine.tick(); await until(() => fixture.store.job(second.id).status === "running");
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
