import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { saveInput, saveOutput, deleteInput, deleteOutput, outputBytes } from "../../apps/server/media.ts";
import { BIREFNET_ARTIFACT, BIREFNET_MEMORY, verifySnapshot, type ExecutionSnapshot, type NodeInfo } from "../../packages/inference/index.ts";
import { engineFixture, until } from "./helpers/engine-fixture.ts";
import { FakeObjectStore } from "./helpers/fake-object-store.ts";

const sharp = createRequire(new URL("../../apps/server/package.json", import.meta.url))("sharp");
const nodes = JSON.parse(await readFile(new URL("../inference/fixtures/editing-object-info.json", import.meta.url), "utf8")) as Record<string, NodeInfo>;
type Fixture = Awaited<ReturnType<typeof engineFixture>>;
const png = (width = 512, height = 384) => sharp({ create: { width, height, channels: 4, background: { r: 100, g: 120, b: 140, alpha: .5 } } }).png().toBuffer();
function install(f: Fixture, index = 0) {
  const state = f.workers[index].state;
  Object.assign(state.info, structuredClone(nodes));
  state.info.ImageScale.input!.required!.upscale_method = [["lanczos", "bicubic", "nearest-exact"]];
  const previous = state.responseOverride;
  state.responseOverride = path => path === "/models/background_removal" ? { body: JSON.stringify([BIREFNET_ARTIFACT.filename]) } : previous?.(path);
  f.engine.invalidateWorkers();
}
async function cutout(f: Fixture, value: unknown, key = randomUUID(), userId = f.owner.id) {
  const previous = f.engine.ticking; f.engine.ticking = true;
  try { return await f.engine.submitBackgroundRemoval(userId, value, key); } finally { f.engine.ticking = previous; }
}
async function imported(f: Fixture, width = 512, height = 384) { return saveInput(f.store, f.owner.id, await png(width, height), "source.png"); }

test("standalone cutout is gated by its complete graph and retains the source across restart", async t => {
  const f = await engineFixture({ count: 2 }); t.after(f.close);
  const source = { type: "input", inputId: (await imported(f)).id };
  assert.equal((await f.engine.backgroundRemoval()).ready, false);
  await assert.rejects(cutout(f, { source }), { code: "BACKGROUND_REMOVAL_UNAVAILABLE" });
  install(f, 1);
  assert.equal((await f.engine.backgroundRemoval()).ready, true);
  const key = randomUUID(), job = await cutout(f, { source }, key);
  assert.deepEqual(f.store.job(job.id).placements.map(p => p.worker.id), ["worker-1"]);
  assert.deepEqual(f.store.job(job.id).placements[0].memory, BIREFNET_MEMORY);
  assert.equal((await cutout(f, { operation: "remove-background", modelId: "birefnet", source }, key)).id, job.id);
  await assert.rejects(deleteInput(f.store, source.inputId, f.owner.id), { code: "INPUT_IN_USE" });
  await f.restart();
  assert.equal((await cutout(f, { source }, key)).id, job.id);
  await assert.rejects(deleteInput(f.store, source.inputId, f.owner.id), { code: "INPUT_IN_USE" });
  f.engine.cancel(f.owner.id, job.id);
  await deleteInput(f.store, source.inputId, f.owner.id);
});

test("cutout rejects foreign sources, malformed requests and deletion races", async t => {
  const f = await engineFixture(); t.after(f.close); install(f);
  const source = { type: "input", inputId: (await imported(f)).id };
  const other = randomUUID();
  f.store.db.prepare("INSERT INTO users(id,username,password,created_at) VALUES(?,?,?,?)").run(other, "other", "fixture", new Date().toISOString());
  f.engine.workTime.adjust(f.owner.id, other, 60_000, "Fixture allowance", "cutout-allowance");
  await assert.rejects(cutout(f, { source }, randomUUID(), other), { code: "INPUT_NOT_FOUND" });
  for (const bad of [{ source, modelId: "unknown" }, { source, operation: "upscale" }, { source: { ...source, url: "https://example.org/image.png" } }, { source, prompt: "unexpected" }]) await assert.rejects(cutout(f, bad));
  const refresh = f.engine.refreshWorkers.bind(f.engine);
  f.engine.refreshWorkers = async () => { await refresh(); f.store.beginInputDeletion(source.inputId, f.owner.id); };
  await assert.rejects(cutout(f, { source }), { code: "INPUT_DELETION_PENDING" });
  assert.equal(f.store.jobs().length, 0);
});

test("cutout reads an owned S3 output once and saves a separate transparent image at the same size", async t => {
  const objects = new FakeObjectStore(), f = await engineFixture({ objectStore: objects }); t.after(f.close); install(f);
  const original = await f.queue();
  f.store.patchJob(original.id, { status: "preparing" });
  const output = await saveOutput(f.store, original.id, 0, await png());
  f.store.patchJob(original.id, { status: "succeeded", outputs: [output] });
  const job = await cutout(f, { source: { type: "output", jobId: original.id, outputId: output.id } });
  await assert.rejects(deleteOutput(f.store, original.id, output.id, f.owner.id), { code: "OUTPUT_IN_USE" });
  f.workers[0].state.outputBytes = await png();
  await f.engine.tick(); await until(() => f.store.job(job.id).status === "running");
  const running = f.store.job(job.id), snapshot = running.snapshot as ExecutionSnapshot;
  verifySnapshot(snapshot); assert.equal(snapshot.inputs[0].subfolder, `grav/${job.id}`);
  assert.equal(objects.gets.length, 1);
  f.complete(0, running.promptId!); await until(() => f.store.job(job.id).status === "succeeded");
  const result = f.store.job(job.id).outputs[0];
  assert.equal(result.width, output.width); assert.equal(result.height, output.height);
  assert.equal((await sharp(await outputBytes(f.store, job.id, result.id, f.owner.id)).metadata()).hasAlpha, true);
  assert.equal(f.store.job(original.id).outputs.length, 1);
});

test("masks require owned matching inputs, remain locked while queued and rebind independently after restart", async t => {
  const f = await engineFixture(); t.after(f.close); install(f);
  const source = await imported(f, 768, 512), mask = await imported(f, 768, 512), wrong = await imported(f, 256, 256);
  const base = { images: [source.id], operation: "image-to-image" as const, prompt: "Replace the selected area", matchSource: true };
  await assert.rejects(f.queue({ ...base, maskId: wrong.id }), { code: "INVALID_MASK_SIZE" });
  await assert.rejects(f.queue({ ...base, maskId: mask.id, outpaint: { left: 64, right: 0, top: 0, bottom: 0 } }));
  const other = randomUUID();
  f.store.db.prepare("INSERT INTO users(id,username,password,created_at) VALUES(?,?,?,?)").run(other, "other", "fixture", new Date().toISOString());
  const foreign = await saveInput(f.store, other, await png(768, 512), "foreign-mask.png");
  await assert.rejects(f.queue({ ...base, maskId: foreign.id }), { code: "INPUT_NOT_FOUND" });
  const job = await f.queue({ ...base, maskId: mask.id });
  assert.equal(job.parameters.width, 768); assert.equal(job.parameters.height, 512);
  for (const id of [source.id, mask.id]) await assert.rejects(deleteInput(f.store, id, f.owner.id), { code: "INPUT_IN_USE" });
  await f.restart();
  await assert.rejects(deleteInput(f.store, mask.id, f.owner.id), { code: "INPUT_IN_USE" });
  await f.engine.tick(); await until(() => f.store.job(job.id).status === "running");
  const frozen = f.store.job(job.id).snapshot as ExecutionSnapshot;
  verifySnapshot(frozen);
  assert("mask" in frozen && frozen.mask);
  assert.equal(frozen.mask.subfolder, `grav/${job.id}`);
  assert.equal(frozen.mask.filename, `${mask.id}.png`);
  assert.equal(frozen.inputs[0].filename, `${source.id}.png`);
  assert.equal(frozen.inputs[0].subfolder, `grav/${job.id}`);
  assert.deepEqual(frozen.graph.edit_mask_image.inputs.image, `grav/${job.id}/${mask.id}.png`);
  f.complete(0, f.store.job(job.id).promptId!); await until(() => f.store.job(job.id).status === "succeeded");
  await deleteInput(f.store, mask.id, f.owner.id);
});

test("adapter readiness follows the selected model's assigned worker and saved weights survive registry changes", async t => {
  const { saveImportedExtension } = await import("../../apps/server/registry.ts");
  const { snapshotHash } = await import("../../packages/inference/compiler.ts");
  const f = await engineFixture({ count: 2 }); t.after(f.close);
  const extension = { id: "hf-lora-fixture", name: "Fixture style", revision: "1", kind: "lora" as const, category: "image" as const, description: "Fixture", familyIds: ["sdxl" as const], artifacts: [{ role: "lora" as const, folder: "loras" as const, filename: "fixture.safetensors" }], memory: { ramBytes: 2 * 1024 ** 3, vramBytes: 1024 ** 3 } };
  saveImportedExtension(f.store, extension);
  const settings = f.store.settings(); settings.modelConfigurations.find(model => model.modelId === "sdxl-base")!.workerIds = ["worker-0"]; f.store.saveSettings(settings);
  const installLora = (index: number) => {
    install(f, index);
    const state = f.workers[index].state, previous = state.responseOverride;
    state.responseOverride = path => path === "/models/loras" ? { body: JSON.stringify(["fixture.safetensors"]) } : previous?.(path);
    f.engine.invalidateWorkers();
  };
  installLora(1);
  let tool = (await f.engine.generationTools("sdxl-base")).tools.find(tool => tool.id === extension.id)!;
  assert.equal(tool.installed, true); assert.equal(tool.ready, false, "Another worker's files cannot enable this model's adapter");
  const source = await imported(f);
  const request = { images: [source.id], operation: "image-to-image" as const, loras: [{ id: extension.id, strength: .7 }] };
  await assert.rejects(f.queue(request), { code: "MODEL_UNAVAILABLE" });
  installLora(0);
  tool = (await f.engine.generationTools("sdxl-base")).tools.find(tool => tool.id === extension.id)!;
  assert.equal(tool.ready, true);
  const job = await f.queue(request);
  assert.equal(f.store.job(job.id).placements[0].memory.vramBytes, 7 * 1024 ** 3);
  const saved = f.store.job(job.id).snapshot as import("../../packages/inference/types.ts").GenerationSnapshot;
  saved.parameters.steps = 17; saved.graph.sample.inputs.steps = 17; saved.recipe.revision = "archived";
  const { hash, ...content } = saved;
  // Seed an archived queued record in this isolated test database, as if it
  // had been created by an older release with a different family recipe.
  f.store.db.prepare("UPDATE jobs SET body=json_set(body,'$.snapshot',json(?)) WHERE id=?")
    .run(JSON.stringify({ ...content, hash: snapshotHash(content) }), job.id);
  saveImportedExtension(f.store, { ...extension, revision: "2", artifacts: [{ ...extension.artifacts[0], filename: "replacement.safetensors" }] });
  await f.restart(); await f.engine.tick(); await until(() => f.store.job(job.id).status === "running");
  const running = f.store.job(job.id).snapshot as import("../../packages/inference/types.ts").GenerationSnapshot;
  verifySnapshot(running);
  assert.equal(running.graph.lora_0.inputs.lora_name, "fixture.safetensors");
  assert.equal(running.extensions![0].revision, "1");
  assert.equal(running.parameters.steps, 17); assert.equal(running.graph.sample.inputs.steps, 17);
  assert.equal(running.recipe.revision, "archived");
  f.complete(0, f.store.job(job.id).promptId!); await until(() => f.store.job(job.id).status === "succeeded");
});
