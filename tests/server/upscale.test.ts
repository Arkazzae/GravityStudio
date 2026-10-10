import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { saveInput, saveOutput, deleteInput, deleteOutput, outputBytes } from "../../apps/server/media.ts";
import { UPSCALER_MODELS, verifySnapshot, type ExecutionSnapshot } from "../../packages/inference/index.ts";
import type { UpscaleInput } from "../../packages/contracts/index.ts";
import { engineFixture, until } from "./helpers/engine-fixture.ts";
import { FakeObjectStore } from "./helpers/fake-object-store.ts";

const sharp = createRequire(new URL("../../apps/server/package.json", import.meta.url))("sharp");

type Fixture = Awaited<ReturnType<typeof engineFixture>>;
const nomos = () => UPSCALER_MODELS.find(model => model.id === "nomos2-hq")!;
function install(fixture: Fixture, index = 0) {
  const state = fixture.workers[index].state;
  Object.assign(state.info, {
    UpscaleModelLoader: { input: { required: { model_name: [[nomos().artifacts[0].filename]] } }, output: ["UPSCALE_MODEL"] },
    ImageUpscaleWithModel: { input: { required: { upscale_model: ["UPSCALE_MODEL"], image: ["IMAGE"] } }, output: ["IMAGE"] },
    JoinImageWithAlpha: { input: { required: { image: ["IMAGE"], alpha: ["MASK"] } }, output: ["IMAGE"] },
  });
  const original = state.responseOverride;
  state.responseOverride = path => path === "/models/upscale_models" ? { body: JSON.stringify(nomos().artifacts.map(artifact => artifact.filename)) } : original?.(path);
  fixture.engine.invalidateWorkers();
}
const png = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: { r: 100, g: 120, b: 140, alpha: 0.5 } } }).png().toBuffer();
async function request(fixture: Fixture): Promise<UpscaleInput> {
  const image = await saveInput(fixture.store, fixture.owner.id, await png(512, 384), "source.png");
  return { operation: "upscale", modelId: nomos().id, source: { type: "input", inputId: image.id }, scale: 2 };
}
async function queue(fixture: Fixture, input: unknown, key = randomUUID(), userId = fixture.owner.id) {
  const previous = fixture.engine.ticking; fixture.engine.ticking = true;
  try { return await fixture.engine.submitUpscale(userId, input, key); }
  finally { fixture.engine.ticking = previous; }
}
async function originalOutput(fixture: Fixture) {
  const sourceJob = await fixture.queue();
  fixture.store.patchJob(sourceJob.id, { status: "preparing" });
  const output = await saveOutput(fixture.store, sourceJob.id, 0, await png(512, 384));
  fixture.store.patchJob(sourceJob.id, { status: "succeeded", outputs: [output] });
  return { jobId: sourceJob.id, output };
}

test("upscalers require installed weights and nodes and use only capable enabled workers", async t => {
  const fixture = await engineFixture({ count: 2 }); t.after(fixture.close);
  const input = await request(fixture);
  assert((await fixture.engine.upscalers()).models.every(model => !model.ready && !model.installed));
  await assert.rejects(queue(fixture, input), { code: "UPSCALER_UNAVAILABLE" });
  install(fixture, 1);
  const card = (await fixture.engine.upscalers()).models.find(model => model.id === nomos().id)!;
  assert.equal(card.installed, true); assert.equal(card.ready, true);
  assert(!(await fixture.engine.catalog()).models.some(model => model.id === nomos().id));
  const job = await queue(fixture, input);
  assert.deepEqual(fixture.store.job(job.id).placements.map(placement => placement.worker.id), ["worker-1"]);
  assert.equal(job.parameters.width, 1024); assert.equal(job.parameters.height, 768);
  assert.deepEqual(fixture.store.job(job.id).placements[0].memory, nomos().memory);
  delete fixture.workers[1].state.info.ImageUpscaleWithModel;
  await fixture.engine.tick();
  await until(() => fixture.store.job(job.id).status === "failed");
  assert.equal(fixture.workers[1].state.submissions.length, 0);
});

test("upscale validates ownership, source shape, operation, scale and size before queueing", async t => {
  const fixture = await engineFixture(); t.after(fixture.close); install(fixture);
  const input = await request(fixture);
  const other = { id: randomUUID() };
  await assert.rejects(queue(fixture, input, randomUUID(), other.id), { code: "INPUT_NOT_FOUND" });
  for (const bad of [{ ...input, operation: "reference" }, { ...input, source: { ...input.source, url: "https://example.com/image.png" } }, { ...input, source: { type: "url", url: "https://example.com/image.png" } }, { ...input, prompt: "unexpected" }, { ...input, scale: 3 }, { ...input, seed: -1 }]) {
    await assert.rejects(queue(fixture, bad));
  }
  const large = await saveInput(fixture.store, fixture.owner.id, await png(2049, 128), "large.png");
  await assert.rejects(queue(fixture, { ...input, source: { type: "input", inputId: large.id } }));
  const source = await originalOutput(fixture);
  await assert.rejects(queue(fixture, { ...input, source: { type: "output", jobId: source.jobId, outputId: source.output.id } }, randomUUID(), other.id), { code: "JOB_NOT_FOUND" });
  assert.equal(fixture.store.activeJobs().length, 0);
});

test("upscale retries return one job and retain the imported source across restart until cancellation", async t => {
  const fixture = await engineFixture(); t.after(fixture.close); install(fixture);
  const input = await request(fixture), key = randomUUID();
  const [first, second] = await Promise.all([queue(fixture, input, key), queue(fixture, input, key)]);
  assert.equal(first.id, second.id); assert.equal(fixture.store.jobs().length, 1);
  await assert.rejects(queue(fixture, { ...input, scale: 4 }, key), { code: "IDEMPOTENCY_CONFLICT" });
  assert(input.source.type === "input");
  await assert.rejects(deleteInput(fixture.store, input.source.inputId, fixture.owner.id), { code: "INPUT_IN_USE" });
  await fixture.restart();
  assert.equal((await queue(fixture, input, key)).id, first.id);
  assert.equal(fixture.store.job(first.id).input.operation, "upscale");
  await assert.rejects(deleteInput(fixture.store, input.source.inputId, fixture.owner.id), { code: "INPUT_IN_USE" });
  fixture.engine.cancel(fixture.owner.id, first.id);
  await deleteInput(fixture.store, input.source.inputId, fixture.owner.id);
  assert.equal((await queue(fixture, input, key)).id, first.id);
});

test("saved outputs cannot be removed while referenced and pending deletion cannot acquire an upscale", async t => {
  const fixture = await engineFixture(); t.after(fixture.close); install(fixture);
  const { jobId, output } = await originalOutput(fixture);
  const input: UpscaleInput = { operation: "upscale", modelId: nomos().id, source: { type: "output", jobId, outputId: output.id }, scale: 2 };
  const job = await queue(fixture, input);
  await assert.rejects(deleteOutput(fixture.store, jobId, output.id, fixture.owner.id), { code: "OUTPUT_IN_USE" });
  fixture.engine.cancel(fixture.owner.id, job.id);
  fixture.store.beginOutputDeletion(jobId, output.id, fixture.owner.id);
  await assert.rejects(queue(fixture, input), { code: "OUTPUT_DELETION_PENDING" });
  await deleteOutput(fixture.store, jobId, output.id, fixture.owner.id);
});

test("source deletion during worker discovery is rechecked atomically at job creation", async t => {
  const fixture = await engineFixture(); t.after(fixture.close); install(fixture);
  const input = await request(fixture);
  assert(input.source.type === "input");
  const inputId = input.source.inputId, refresh = fixture.engine.refreshWorkers.bind(fixture.engine);
  fixture.engine.refreshWorkers = async () => { await refresh(); fixture.store.beginInputDeletion(inputId, fixture.owner.id); };
  await assert.rejects(queue(fixture, input), { code: "INPUT_DELETION_PENDING" });
  assert.equal(fixture.store.jobs().length, 0);
});

test("upscale loads an S3 source once, binds its scoped upload, and saves a separate transparent result", async t => {
  const objects = new FakeObjectStore();
  const fixture = await engineFixture({ objectStore: objects }); t.after(fixture.close); install(fixture);
  const source = await originalOutput(fixture);
  const input: UpscaleInput = { operation: "upscale", modelId: nomos().id, source: { type: "output", jobId: source.jobId, outputId: source.output.id }, scale: 2 };
  const job = await queue(fixture, input);
  const hash = (fixture.store.job(job.id).snapshot as ExecutionSnapshot).hash;
  fixture.workers[0].state.outputBytes = await png(1024, 768);
  await fixture.engine.tick();
  await until(() => fixture.store.job(job.id).status === "running");
  const running = fixture.store.job(job.id), snapshot = running.snapshot as ExecutionSnapshot;
  verifySnapshot(snapshot); assert.notEqual(snapshot.hash, hash);
  assert.equal(snapshot.inputs[0].subfolder, `grav/${job.id}`);
  assert.equal(objects.gets.length, 1);
  fixture.complete(0, running.promptId!);
  await until(() => fixture.store.job(job.id).status === "succeeded");
  const result = fixture.store.job(job.id).outputs[0];
  assert.equal(result.width, 1024); assert.equal(result.height, 768);
  assert.notEqual(result.id, source.output.id);
  assert.equal(fixture.store.job(source.jobId).outputs.length, 1);
  assert.equal((await sharp(await outputBytes(fixture.store, job.id, result.id, fixture.owner.id)).metadata()).hasAlpha, true);
  assert.equal(fixture.workers[0].state.submissions.length, 1);
});

test("an upscaler cannot silently return an image at the wrong size", async t => {
  const fixture = await engineFixture(); t.after(fixture.close); install(fixture);
  const job = await queue(fixture, await request(fixture));
  await fixture.engine.tick();
  await until(() => fixture.store.job(job.id).status === "running");
  fixture.complete(0, fixture.store.job(job.id).promptId!);
  await until(() => fixture.store.job(job.id).status === "failed");
  assert.match(fixture.store.job(job.id).error!, /unexpected dimensions/);
  assert.equal(fixture.store.job(job.id).outputs.length, 0);
});
