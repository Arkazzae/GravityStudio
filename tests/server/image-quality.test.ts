import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Engine } from "../../apps/server/engine.ts";
import { saveImportedModel } from "../../apps/server/registry.ts";
import { Store } from "../../apps/server/store.ts";
import { compileGeneration, FAMILY_RECIPES, getModel, listModels } from "../../packages/inference/index.ts";

test("catalog resolution presets are inherited by imported checkpoints without replacing their defaults", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gravity-quality-"));
  const store = new Store(directory);
  const engine = new Engine(store);
  t.after(async () => { await engine.stop(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const imported = getModel("sdxl-base");
  imported.id = "imported-portrait";
  imported.name = "Imported portrait";
  imported.defaults = { steps: 24, cfg: 5.5, sampler: "euler_ancestral" };
  saveImportedModel(store, imported);

  const catalog = await engine.catalog();
  const original = catalog.models.find(model => model.id === "sdxl-base")!;
  const card = catalog.models.find(model => model.id === imported.id)!;
  assert.deepEqual(card.qualityPresets, original.qualityPresets);
  assert.deepEqual(card.qualityPresets, FAMILY_RECIPES.sdxl.qualityPresets);
  assert.deepEqual(card.qualityPresets.map(preset => preset.id), ["fast", "standard", "high"]);
  assert.equal(new Set(card.qualityPresets.map(preset => preset.pixels)).size, 3);
  assert.ok(card.qualityPresets.every(preset => preset.minSide === 512));
  assert.equal(card.dimensions.min, 256, "preset recommendations do not narrow manual sizes");
  assert.equal(card.defaults.steps, 24);
  assert.equal(card.defaults.cfg, 5.5);
  assert.equal(card.defaults.sampler, "euler_ancestral");
  assert.equal(card.ready, false, "presets are available before the model is installed");
});

test("resolution choices preserve each model's sampling defaults in executable snapshots", () => {
  for (const model of listModels()) {
    const family = FAMILY_RECIPES[model.familyId];
    const baseline = compileGeneration({ modelId: model.id, prompt: "A ceramic cup", seed: 1 }, model);
    const { width: _width, height: _height, ...sampling } = baseline.parameters;
    for (const preset of family.qualityPresets) {
      const side = Math.floor(Math.sqrt(preset.pixels) / family.dimensions.multiple) * family.dimensions.multiple;
      const snapshot = compileGeneration({ modelId: model.id, prompt: "A ceramic cup", seed: 1, width: side, height: side }, model);
      const { width, height, ...actualSampling } = snapshot.parameters;
      assert.equal(width, side);
      assert.equal(height, side);
      assert.deepEqual(actualSampling, sampling, `${model.id} ${preset.id} preserves sampling`);
    }
  }
});

test("Krea accepts native 2048-square output while manual dimension and request-field validation remains active", () => {
  const request = { modelId: "krea-2-turbo", prompt: "A ceramic cup", seed: 1, width: 2048, height: 2048 };
  const snapshot = compileGeneration(request);
  assert.equal(snapshot.graph.latent.inputs.width, 2048);
  assert.equal(snapshot.graph.latent.inputs.height, 2048);
  assert.equal(snapshot.parameters.steps, 8);
  assert.throws(() => compileGeneration({ ...request, width: 2064 }), { code: "INVALID_INPUT" });
  assert.throws(() => compileGeneration({ ...request, width: 2047 }), { code: "INVALID_INPUT" });
  assert.throws(() => compileGeneration({ ...request, quality: "high" } as never), { code: "INVALID_INPUT" });
  const manual = compileGeneration({ modelId: "sdxl-base", prompt: "A ceramic cup", seed: 1, width: 256, height: 256 });
  assert.equal(manual.parameters.width, 256);
});
