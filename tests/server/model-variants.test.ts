import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { getModel, GENERATION_EXTENSIONS, type GenerationSnapshot, type ModelManifest, type NodeInfo, type Operation } from "../../packages/inference/index.ts";
import { saveImportedModel } from "../../apps/server/registry.ts";
import { configuredModel, defaultModelConfiguration, modelCard, settingsView } from "../../apps/server/settings.ts";
import { saveInput } from "../../apps/server/media.ts";
import { PNG } from "../inference/fake-comfy.ts";
import { engineFixture, GiB } from "./helpers/engine-fixture.ts";

test("catalog and submissions honor each checkpoint's input variant", async t => {
  const f = await engineFixture(); t.after(f.close);
  const nodes = JSON.parse(await readFile(new URL("../inference/fixtures/editing-object-info.json", import.meta.url), "utf8")) as Record<string, NodeInfo>;
  Object.assign(f.workers[0].state.info, nodes);
  const vision = GENERATION_EXTENSIONS.find(tool => tool.id === "sdxl-clip-vision")!;
  const previous = f.workers[0].state.responseOverride;
  f.workers[0].state.responseOverride = path => path === "/models/clip_vision" ? { body: JSON.stringify(vision.artifacts.map(artifact => artifact.filename)) } : previous?.(path);
  for (const operation of ["text-to-image", "image-to-image", "reference"] as Operation[]) {
    const model = { ...getModel("sdxl-base"), id: `variant-${operation}`, name: `Variant ${operation}`, operations: [operation], defaults: { steps: 17, cfg: 4 } };
    saveImportedModel(f.store, model);
  }
  const settings = settingsView(f.store);
  for (const configuration of settings.modelConfigurations.filter(item => item.modelId.startsWith("variant-"))) {
    configuration.enabled = true; configuration.workerIds = ["worker-0"]; configuration.memory = { ramBytes: 8 * GiB, vramBytes: 6 * GiB, source: "estimate" };
  }
  f.store.saveSettings(settings); f.engine.invalidateWorkers();
  const cards = (await f.engine.catalog()).models;
  for (const operation of ["text-to-image", "image-to-image", "reference"] as Operation[]) {
    const card = cards.find(item => item.id === `variant-${operation}`)!;
    assert.equal(card.ready, true, `${operation} is probed with its actual workflow`);
    assert.deepEqual(card.operations, [operation]);
    assert.equal(card.capabilities.requiresImage, operation !== "text-to-image");
    assert.equal(card.capabilities.maxImages, operation === "text-to-image" ? 0 : operation === "reference" ? 4 : 1);
    assert.equal(card.capabilities.reference, operation === "reference");
    assert.equal(card.qualityPresets.find(preset => preset.id === "high")!.sampling!.steps, 17);
  }
  const image = await saveInput(f.store, f.owner.id, Buffer.from(PNG), "source.png");
  for (const operation of ["image-to-image", "reference"] as Operation[]) {
    const job = await f.queue({ modelId: `variant-${operation}`, images: [image.id] });
    assert.equal(job.input!.operation, operation);
    const snapshot = f.store.job(job.id).snapshot as GenerationSnapshot;
    assert.equal(snapshot.recipe.operation, operation);
    if (operation === "reference") assert.ok(snapshot.auxiliaryArtifacts?.some(artifact => artifact.role === "clip-vision"));
    await assert.rejects(f.queue({ modelId: `variant-${operation}` }), /image|reference/i);
  }
  await assert.rejects(f.queue({ modelId: "variant-text-to-image", images: [image.id] }), /image|reference/i);
});

test("changing a configured local artifact removes stale download provenance", () => {
  const model = getModel("flux-2-klein-4b");
  const configuration = defaultModelConfiguration(model);
  const artifact = model.artifacts.find(item => item.role === "text-encoder")!;
  configuration.artifacts[artifact.role] = "replacement.safetensors";
  const resolved = configuredModel(configuration);
  const replacement = resolved.artifacts.find(item => item.role === artifact.role)!;
  assert.equal(replacement.source, undefined);
  assert.equal(replacement.sha256, undefined);
  assert.deepEqual(resolved.artifacts.find(item => item.role === "diffusion"), model.artifacts.find(item => item.role === "diffusion"));
  const card = modelCard({ ...model, operations: ["text-to-image"] } as ModelManifest, configuration, []);
  assert.equal(card.capabilities.minImages, 0);
});
