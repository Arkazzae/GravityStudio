import assert from "node:assert/strict";
import { test } from "node:test";
import { compileGeneration, rebindGenerationInputs, snapshotHash, verifySnapshot } from "../../packages/inference/index.ts";
import type { GenerationSnapshot, InputImage } from "../../packages/inference/index.ts";

const image: InputImage = { filename: "source.png", subfolder: "saved", type: "input" };
const mask: InputImage = { filename: "mask.png", subfolder: "saved", type: "input" };
const uploaded: InputImage = { filename: "source-worker.png", subfolder: "grav/job", type: "input" };
const uploadedMask: InputImage = { filename: "mask-worker.png", subfolder: "grav/job", type: "input" };

test("rebinding changes only recorded LoadImage paths and retains the archived recipe exactly", () => {
  const compiled = compileGeneration({ modelId: "sdxl-base", prompt: "Keep saved/source.png lettering", seed: 12, operation: "image-to-image", images: [image], mask, sourceSize: { width: 1024, height: 768 }, refiner: true, quality: "ultra" });
  // Represent an older queued recipe; recompiling today must not replace it.
  const { hash: _hash, ...archived } = compiled;
  archived.recipe.revision = "archived-recipe";
  archived.parameters.steps = 17;
  archived.graph.sample.inputs.end_at_step = 13;
  archived.graph.refiner_sample.inputs.start_at_step = 13;
  archived.graph.refiner_sample.inputs.steps = 17;
  archived.graph.unrelated = { class_type: "LoadImage", inputs: { image: "fixed/internal.png" } };
  const saved: GenerationSnapshot = { ...archived, hash: snapshotHash(archived) };
  const original = structuredClone(saved);
  const result = rebindGenerationInputs(saved, [uploaded], uploadedMask);
  verifySnapshot(result);
  assert.deepEqual(saved, original, "binding must not mutate persisted state");
  assert.notEqual(result.hash, saved.hash);
  assert.deepEqual(result.inputs, [uploaded]);
  assert.deepEqual(result.mask, uploadedMask);
  assert.equal(result.graph.input_image.inputs.image, "grav/job/source-worker.png");
  assert.equal(result.graph.edit_source.inputs.image, "grav/job/source-worker.png");
  assert.equal(result.graph.edit_mask_image.inputs.image, "grav/job/mask-worker.png");
  const restored = structuredClone(result);
  restored.hash = saved.hash;
  restored.inputs = saved.inputs;
  restored.mask = saved.mask;
  for (const [id, node] of Object.entries(saved.graph)) if (node.class_type === "LoadImage") restored.graph[id].inputs.image = node.inputs.image;
  assert.deepEqual(restored, saved, "all other nodes, defaults, metadata, artifacts and output pointers are frozen");
});

test("ten references bind in order, including consistent repeated images", () => {
  const images = Array.from({ length: 10 }, (_, i) => ({ ...image, filename: `image-${i % 9}.png` }));
  const uploads = images.map(item => ({ ...item, subfolder: "grav/worker" }));
  const snapshot = compileGeneration({ modelId: "qwen-image-2.1", prompt: "Combine the references", operation: "reference", images, seed: 42 });
  const bound = rebindGenerationInputs(snapshot, uploads);
  verifySnapshot(bound);
  for (let i = 0; i < 10; i++) assert.equal(bound.graph[`reference_${i}`].inputs.image, `grav/worker/image-${i % 9}.png`);
  assert.throws(() => rebindGenerationInputs(snapshot, [...uploads.slice(0, 9), { ...uploads[9], filename: "different.png" }]), /same worker upload/);
});

test("binding validates integrity, exact input and mask counts, safe paths and saved graph coverage", () => {
  const snapshot = compileGeneration({ modelId: "sdxl-base", prompt: "A vase", operation: "image-to-image", images: [image], mask, sourceSize: { width: 1024, height: 768 }, seed: 42 });
  assert.throws(() => rebindGenerationInputs({ ...snapshot, hash: "0".repeat(64) }, [uploaded], uploadedMask), /changed after compilation/);
  assert.throws(() => rebindGenerationInputs(snapshot, [], uploadedMask), /match the saved generation inputs/);
  assert.throws(() => rebindGenerationInputs(snapshot, [uploaded]), /saved generation mask/);
  assert.throws(() => rebindGenerationInputs(snapshot, [{ ...uploaded, filename: "../private.png" }], uploadedMask), /uploaded input image/);
  assert.throws(() => rebindGenerationInputs(snapshot, [uploaded], { ...uploadedMask, subfolder: "/private" }), /input image folder/);
  const { hash: _hash, ...missing } = structuredClone(snapshot);
  delete missing.graph.edit_mask_image;
  assert.throws(() => rebindGenerationInputs({ ...missing, hash: snapshotHash(missing) }, [uploaded], uploadedMask), /does not contain all/);
  const text = compileGeneration({ modelId: "sdxl-base", prompt: "A vase", seed: 42 });
  assert.deepEqual(rebindGenerationInputs(text, []), text);
  assert.throws(() => rebindGenerationInputs(text, [], uploadedMask), /saved generation mask/);
});
