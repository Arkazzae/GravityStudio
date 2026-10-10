import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import upscaleInfo from "../inference/fixtures/upscale-object-info.json" with { type: "json" };
import backgroundInfo from "../inference/fixtures/background-object-info.json" with { type: "json" };
import { BIREFNET_ARTIFACT, BIREFNET_MEMORY, getUpscaler, UPSCALER_MODELS, verifySnapshot, type GenerationSnapshot, type NodeInfo } from "../../packages/inference/index.ts";
import { saveInput, outputBytes } from "../../apps/server/media.ts";
import { engineFixture, GiB, until } from "./helpers/engine-fixture.ts";

const sharp = createRequire(new URL("../../apps/server/package.json", import.meta.url))("sharp");
const png = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: { r: 100, g: 120, b: 140, alpha: 0.5 } } }).png().toBuffer();
type Fixture = Awaited<ReturnType<typeof engineFixture>>;
function install(fixture: Fixture, index = 0, cutout = false) {
  const state = fixture.workers[index].state;
  Object.assign(state.info, structuredClone(upscaleInfo), structuredClone(backgroundInfo));
  const seed = getUpscaler("seedvr2-7b");
  const files: Record<string, string[]> = {};
  for (const artifact of [...seed.artifacts, ...(cutout ? [BIREFNET_ARTIFACT] : [])]) (files[artifact.folder] ??= []).push(artifact.filename);
  state.info.UNETLoader.input!.required!.unet_name = [files.diffusion_models];
  state.info.VAELoader.input!.required!.vae_name = [files.vae];
  const previous = state.responseOverride;
  state.responseOverride = path => path.startsWith("/models/") && files[path.slice(8)] ? { body: JSON.stringify(files[path.slice(8)]) } : previous?.(path);
  fixture.stats[index].system.ram_total = fixture.stats[index].system.ram_free = 128 * GiB;
  fixture.stats[index].devices[0].vram_total = fixture.stats[index].devices[0].vram_free = 32 * GiB;
  fixture.engine.invalidateWorkers();
}

test("Ultra requires Seed7B on an assigned generation worker and preserves ordinary availability", async t => {
  const fixture = await engineFixture({ count: 2 }); t.after(fixture.close);
  let card = (await fixture.engine.catalog()).models.find(model => model.id === "sdxl-base")!;
  assert.equal(card.ready, true); assert.equal(card.capabilities.ultra.available, false);
  await assert.rejects(fixture.queue({ quality: "ultra" }), { code: "MODEL_UNAVAILABLE" });
  install(fixture, 1);
  card = (await fixture.engine.catalog()).models.find(model => model.id === "sdxl-base")!;
  assert.equal(card.capabilities.ultra.available, true);
  assert.equal(card.capabilities.ultra.transparentAvailable, false);
  const job = await fixture.queue({ quality: "ultra", width: 768, height: 768 });
  assert.deepEqual(fixture.store.job(job.id).placements.map(item => item.worker.id), ["worker-1"]);
  assert.equal(job.parameters.width, 1024); assert.equal(job.parameters.height, 1024);
  assert.equal(job.parameters.quality, "ultra");
  const stored = fixture.store.job(job.id);
  assert.equal(stored.placements[0].memory.ramBytes, 32 * GiB);
  assert.equal(stored.placements[0].memory.vramBytes, 29 * GiB);
  const settings = fixture.store.settings();
  settings.modelConfigurations.find(model => model.modelId === "sdxl-base")!.workerIds = ["worker-0"];
  fixture.store.saveSettings(settings);
  await assert.rejects(fixture.queue({ quality: "ultra" }), { code: "MODEL_UNAVAILABLE" });
});

test("Ultra capacity and transparency describe the complete pipeline on one worker", async t => {
  const fixture = await engineFixture({ count: 2 }); t.after(fixture.close);
  install(fixture, 0); install(fixture, 1, true);
  fixture.stats[0].devices[0].vram_total = 24 * GiB;
  fixture.stats[1].devices[0].vram_total = 24 * GiB;
  let card = (await fixture.engine.catalog()).models.find(model => model.id === "sdxl-base")!;
  assert.equal(card.capabilities.ultra.available, false);
  assert.match(card.capabilities.ultra.reason!, /memory|capacity/i);
  fixture.stats[1].devices[0].vram_total = 32 * GiB;
  card = (await fixture.engine.catalog()).models.find(model => model.id === "sdxl-base")!;
  assert.equal(card.capabilities.ultra.available, true);
  assert.equal(card.capabilities.ultra.transparentAvailable, true);
  const job = await fixture.queue({ quality: "ultra", background: "transparent" });
  const stored = fixture.store.job(job.id), snapshot = stored.snapshot as GenerationSnapshot;
  assert.deepEqual(stored.placements.map(item => item.worker.id), ["worker-1"]);
  assert.equal(stored.placements[0].memory.ramBytes, 32 * GiB + BIREFNET_MEMORY.ramBytes);
  assert.equal(stored.placements[0].memory.vramBytes, 29 * GiB);
  assert.deepEqual(snapshot.graph.ultra_source.inputs.image, ["background_rgba", 0]);
});

test("Ultra remains one idempotent durable job and one reserved clock through uncertain submission and restart", async t => {
  const fixture = await engineFixture(); t.after(fixture.close); install(fixture);
  const key = randomUUID(), input = { quality: "ultra" as const, width: 1024, height: 768 };
  const first = await fixture.queue(input, key);
  assert.equal((await fixture.queue(input, key)).id, first.id);
  await assert.rejects(fixture.queue({ ...input, quality: undefined }, key), { code: "IDEMPOTENCY_CONFLICT" });
  fixture.workers[0].state.postBehavior = "drop-after-accept";
  const originalResponse = fixture.workers[0].state.responseOverride;
  fixture.workers[0].state.responseOverride = path => fixture.workers[0].state.submissions.length && (path === "/queue" || path.startsWith("/history"))
    ? { status: 503, body: "temporarily unavailable" } : originalResponse?.(path);
  await fixture.engine.tick();
  await until(() => fixture.store.job(first.id).status === "interrupted");
  assert.equal(fixture.engine.workTime.view(fixture.owner.id).balance.activeTasks, 1);
  assert.equal(fixture.workers[0].state.submissions.length, 1);
  fixture.workers[0].state.responseOverride = originalResponse;
  await fixture.restart();
  assert.equal((await fixture.queue(input, key)).id, first.id);
  assert.equal(fixture.engine.workTime.view(fixture.owner.id).balance.activeTasks, 1);
  const snapshot = fixture.store.job(first.id).snapshot as GenerationSnapshot;
  verifySnapshot(snapshot);
  fixture.workers[0].state.outputBytes = await png(snapshot.postprocess!.width, snapshot.postprocess!.height);
  fixture.complete(0, first.id);
  await fixture.engine.reconcile();
  await until(() => fixture.store.job(first.id).status === "succeeded");
  const result = fixture.store.job(first.id);
  assert.equal(fixture.store.jobs().length, 1); assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].width, 4096);
  assert.equal(result.outputs[0].height, snapshot.postprocess!.height);
  assert.equal(result.parameters.width, snapshot.parameters.width);
  assert.equal(fixture.engine.workTime.view(fixture.owner.id).balance.activeTasks, 0);
  assert.equal(fixture.workers[0].state.submissions.length, 1);
  assert.equal((await sharp(await outputBytes(fixture.store, first.id, result.outputs[0].id, fixture.owner.id)).metadata()).hasAlpha, true);
});

test("reference uploads retain the frozen Ultra upscaler when the catalog changes", async t => {
  const fixture = await engineFixture(); t.after(fixture.close); install(fixture);
  const image = await saveInput(fixture.store, fixture.owner.id, await png(512, 384), "reference.png");
  const job = await fixture.queue({ quality: "ultra", images: [image.id] });
  const frozen = fixture.store.job(job.id).snapshot as GenerationSnapshot;
  const model = UPSCALER_MODELS.find(item => item.id === "seedvr2-7b")!;
  const filename = model.artifacts[0].filename;
  model.artifacts[0].filename = "new-catalog-seed.safetensors";
  try {
    await fixture.engine.tick();
    await until(() => fixture.store.job(job.id).status === "running");
    const rebound = fixture.store.job(job.id).snapshot as GenerationSnapshot;
    verifySnapshot(rebound);
    assert.notEqual(rebound.hash, frozen.hash);
    assert.deepEqual(rebound.postprocess, frozen.postprocess);
    assert.equal(rebound.graph.ultra_model.inputs.unet_name, filename);
    assert.equal(rebound.inputs[0].subfolder, `grav/${job.id}`);
  } finally { model.artifacts[0].filename = filename; }
});

test("Ultra rejects missing restoration nodes before submission and incorrect final dimensions after execution", async t => {
  const fixture = await engineFixture(); t.after(fixture.close); install(fixture);
  const rejected = await fixture.queue({ quality: "ultra" });
  const node = fixture.workers[0].state.info.SeedVR2Preprocess;
  delete fixture.workers[0].state.info.SeedVR2Preprocess;
  await fixture.engine.tick();
  await until(() => fixture.store.job(rejected.id).status === "failed");
  assert.equal(fixture.workers[0].state.submissions.length, 0);
  fixture.workers[0].state.info.SeedVR2Preprocess = node as NodeInfo;
  const wrong = await fixture.queue({ quality: "ultra" });
  await fixture.engine.tick();
  await until(() => fixture.store.job(wrong.id).status === "running");
  fixture.workers[0].state.outputBytes = await png(1024, 1024);
  fixture.complete(0, fixture.store.job(wrong.id).promptId!);
  await until(() => fixture.store.job(wrong.id).status === "failed");
  assert.match(fixture.store.job(wrong.id).error!, /unexpected dimensions/);
  assert.equal(fixture.store.job(wrong.id).outputs.length, 0);
});

test("Ultra observes user time admission and waits uncharged when queued credit is revoked", async t => {
  const fixture = await engineFixture(); t.after(fixture.close); install(fixture);
  const userId = randomUUID();
  fixture.store.db.prepare("INSERT INTO users(id,username,password,created_at) VALUES(?,?,?,?)").run(userId, "ultra-user", "fixture", new Date().toISOString());
  const submit = async () => {
    fixture.engine.ticking = true;
    try { return await fixture.engine.submit(userId, { modelId: "sdxl-base", prompt: "A cup", quality: "ultra", seed: 42 }, randomUUID()); }
    finally { fixture.engine.ticking = false; }
  };
  await assert.rejects(submit(), { code: "SERVER_TIME_EXHAUSTED" });
  fixture.engine.workTime.adjust(fixture.owner.id, userId, 60_000, "Allow Ultra", "ultra-credit");
  const job = await submit();
  fixture.engine.workTime.adjust(fixture.owner.id, userId, -60_000, "Withdraw unused allowance", "ultra-revoke");
  await fixture.engine.tick();
  assert.equal(fixture.store.job(job.id).status, "queued");
  assert.match(fixture.store.job(job.id).stage!, /server time/);
  assert.equal(fixture.engine.workTime.view(userId).balance.activeTasks, 0);
  assert.equal(fixture.workers[0].state.submissions.length, 0);
  fixture.engine.workTime.adjust(fixture.owner.id, userId, 60_000, "Resume Ultra", "ultra-top-up");
  await fixture.engine.tick();
  await until(() => fixture.store.job(job.id).status === "running");
  assert.equal(fixture.engine.workTime.view(userId).balance.activeTasks, 1);
  assert.equal(fixture.workers[0].state.submissions.length, 1);
});
