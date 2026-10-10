import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ModelLibrary } from "../../apps/server/models.ts";
import { BIREFNET_ARTIFACT, BIREFNET_MEMORY, type NodeInfo } from "../../packages/inference/index.ts";
import { engineFixture, until } from "./helpers/engine-fixture.ts";
import { isUpscaleInput } from "../../packages/contracts/index.ts";

const nodes = JSON.parse(await readFile(new URL("../inference/fixtures/background-object-info.json", import.meta.url), "utf8")) as Record<string, NodeInfo>;
function installCutout(fixture: Awaited<ReturnType<typeof engineFixture>>, index: number) {
  const state = fixture.workers[index].state;
  Object.assign(state.info, structuredClone(nodes));
  const original = state.responseOverride;
  state.responseOverride = path => path === "/models/background_removal" ? { body: JSON.stringify([BIREFNET_ARTIFACT.filename]) } : original?.(path);
}

test("transparent jobs require BiRefNet on the assigned worker without blocking ordinary generation", async t => {
  const fixture = await engineFixture({ count: 2 }); t.after(fixture.close);
  let card = (await fixture.engine.catalog()).models.find(model => model.id === "sdxl-base")!;
  assert.equal(card.ready, true);
  assert.equal(card.capabilities.background.native, false);
  assert.equal(card.capabilities.background.available, false);
  assert.match(card.capabilities.background.reason!, /BiRefNet/);
  await assert.rejects(fixture.queue({ background: "transparent" }), { code: "MODEL_UNAVAILABLE" });
  assert.equal(fixture.store.jobs(fixture.owner.id).length, 0);
  installCutout(fixture, 1);
  fixture.engine.invalidateWorkers();
  card = (await fixture.engine.catalog()).models.find(model => model.id === "sdxl-base")!;
  assert.equal(card.capabilities.background.available, true);
  const normal = await fixture.queue();
  const transparent = await fixture.queue({ background: "transparent" });
  const plain = fixture.store.job(normal.id), cutout = fixture.store.job(transparent.id);
  assert.deepEqual(cutout.placements.map(placement => placement.worker.id), ["worker-1"]);
  assert.equal(cutout.placements[0].memory.ramBytes, plain.placements[0].memory.ramBytes + BIREFNET_MEMORY.ramBytes);
  assert.equal(cutout.placements[0].memory.vramBytes, plain.placements[0].memory.vramBytes + BIREFNET_MEMORY.vramBytes);
  assert.equal(transparent.parameters.background, "transparent");
  assert(!isUpscaleInput(transparent.input));
  assert.equal(transparent.input.background, "transparent");
  await fixture.restart();
  const restored = fixture.store.job(transparent.id).input;
  assert(!isUpscaleInput(restored));
  assert.equal(restored.background, "transparent");
});

test("removing background support after queueing fails before ComfyUI submission", async t => {
  const fixture = await engineFixture(); t.after(fixture.close);
  installCutout(fixture, 0);
  const job = await fixture.queue({ background: "transparent" });
  delete fixture.workers[0].state.info.RemoveBackground;
  await fixture.engine.tick();
  await until(() => fixture.store.job(job.id).status === "failed");
  assert.equal(fixture.workers[0].state.submissions.length, 0);
  assert.match(fixture.store.job(job.id).error!, /RemoveBackground/);
});

test("BiRefNet is a pinned optional library tool and a corrupt download cannot activate it", async t => {
  const fixture = await engineFixture(); t.after(fixture.close);
  const previous = fixture.store.settings();
  const calls: string[] = [];
  const library = new ModelLibrary(fixture.store, fixture.engine, { fetch: async url => {
    calls.push(String(url));
    return new Response("corrupt-model-weights", { headers: { "content-length": "21" } });
  } });
  t.after(() => library.close());
  const view = await library.view();
  const tool = view.models.find(model => model.id === "birefnet")!;
  assert.equal("kind" in tool && tool.kind, "utility");
  assert.equal(tool.installed, false);
  assert.equal(tool.downloadable, true);
  assert.equal(calls.length, 0);
  assert.equal((await fixture.engine.catalog()).models.some(model => model.id === "birefnet"), false);
  library.start({ modelId: "birefnet" });
  await library.waitForIdle();
  const failed = await library.view();
  assert.equal(failed.download?.status, "failed");
  assert.match(failed.download?.error ?? "", /SHA-256/);
  assert.deepEqual(calls, [BIREFNET_ARTIFACT.source]);
  assert.deepEqual(await readdir(join(fixture.directory, "models", "background_removal")), []);
  assert.deepEqual(fixture.store.settings(), previous);
});
