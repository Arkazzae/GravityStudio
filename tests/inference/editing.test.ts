import assert from "node:assert/strict";
import { test } from "node:test";
import { compileGeneration, DEFAULT_MODELS, GENERATION_EXTENSIONS, getModel, qualityImageSize, validateGenerationExtension, verifySnapshot, FAMILY_RECIPES } from "../../packages/inference/index.ts";
import type { GenerationRequest, GenerationExtensionManifest, InputImage } from "../../packages/inference/index.ts";
import { sourceCanvasSize } from "../../packages/contracts/image-size.ts";
import { assertPinnedGraph } from "./pinned-schema.test.ts";

const image: InputImage = { filename: "source.png", subfolder: "grav/a", type: "input" };
const mask: InputImage = { filename: "mask.png", subfolder: "grav/b", type: "input" };
const sourceSize = { width: 1024, height: 768 };
const base = { modelId: "sdxl-base", prompt: "A blue ceramic cup", seed: 42 };
const editingModels = ["sdxl-base", "wai-illustrious-v17", "qwen-image-2.1", "flux-2-klein-4b", "ideogram-4-fp8"];
function editingRequest(modelId: string): GenerationRequest { return { ...base, modelId, operation: ["sdxl", "ideogram-4"].includes(getModel(modelId).familyId) ? "image-to-image" : "reference", images: [image], sourceSize }; }

test("source canvases retain aspect and exact legal sizes; bounded padding becomes part of the native canvas", () => {
  const model = { defaults: FAMILY_RECIPES.sdxl.defaults, dimensions: FAMILY_RECIPES.sdxl.dimensions };
  assert.deepEqual(sourceCanvasSize(model, sourceSize), { width: 1024, height: 768, sourceWidth: 1024, sourceHeight: 768 });
  assert.deepEqual(sourceCanvasSize(model, sourceSize, { left: 128, right: 256, top: 0, bottom: 128 }), { width: 1408, height: 896, sourceWidth: 1024, sourceHeight: 768 });
  const large = sourceCanvasSize(model, { width: 8000, height: 6000 }, { left: 128, right: 128, top: 128, bottom: 128 })!;
  assert(large.width * large.height <= model.dimensions.maxPixels);
  assert(Math.abs(large.sourceWidth / large.sourceHeight / (4 / 3) - 1) <= .02);
  for (const padding of [{ left: 1, right: 0, top: 0, bottom: 0 }, { left: 2048, right: 2048, top: 0, bottom: 0 }, { left: -8, right: 0, top: 0, bottom: 0 }]) assert.equal(sourceCanvasSize(model, sourceSize, padding), null);
  assert.equal(sourceCanvasSize(model, { width: Infinity, height: 768 }), null);
});

test("masked edits use white RGB mask, canonical source, latent protection and final RGBA source composition", () => {
  for (const modelId of editingModels) {
    const snapshot = compileGeneration({ ...editingRequest(modelId), mask });
    assertPinnedGraph(snapshot.graph, modelId);
    assert.deepEqual(snapshot.mask, mask);
    assert.deepEqual(snapshot.inputs, [image], "masks remain separate from references on replay");
    assert.deepEqual(snapshot.parameters.sourceSize, sourceSize);
    assert.deepEqual([snapshot.parameters.width, snapshot.parameters.height], [1024, 768]);
    assert.equal(snapshot.graph.edit_mask.inputs.channel, "red");
    assert.deepEqual(snapshot.graph.edit_mask_size.inputs, { image: ["edit_mask_image", 0], upscale_method: "nearest-exact", width: 1024, height: 768, crop: "disabled" });
    assert.deepEqual(snapshot.graph.edit_rgba.inputs.alpha, ["edit_source", 1]);
    assert.deepEqual(snapshot.graph.sample.inputs.latent_image, ["edit_latent", 0]);
    assert.deepEqual(snapshot.graph.edit_composite.inputs.destination, ["edit_size", 0]);
    assert.deepEqual(snapshot.graph.output.inputs.images, ["edit_composite", 0]);
    assert.equal(snapshot.graph.edit_encode.class_type, snapshot.model.familyId === "sdxl" ? "VAEEncodeForInpaint" : "VAEEncode");
    verifySnapshot(snapshot);
  }
});

test("outpainting shares the padded source and hard edit mask while preserving original pixels", () => {
  for (const modelId of editingModels) {
    const outpaint = { left: 128, right: 256, top: 0, bottom: 128 };
    const snapshot = compileGeneration({ ...editingRequest(modelId), outpaint });
    assertPinnedGraph(snapshot.graph, modelId);
    assert.deepEqual([snapshot.parameters.width, snapshot.parameters.height], [1408, 896]);
    assert.deepEqual(snapshot.graph.edit_padding.inputs, { image: ["edit_size", 0], ...outpaint, feathering: 0 });
    assert.deepEqual(snapshot.graph.edit_latent.inputs.mask, ["edit_padding", 1]);
    assert.deepEqual(snapshot.graph.edit_composite.inputs.destination, ["edit_padding", 0]);
    assert.deepEqual(snapshot.parameters.outpaint, outpaint);
    if (modelId === "qwen-image-2.1") assert.deepEqual(snapshot.graph.conditioning.inputs["images.image_1"], ["edit_padding", 0]);
  }
});

test("Qwen source matching restores all reference alpha and uses the first reference's native latent", () => {
  const images = Array.from({ length: 10 }, (_, i) => ({ ...image, filename: `source-${i}.png` }));
  const snapshot = compileGeneration({ ...editingRequest("qwen-image-2.1"), images, matchSource: true });
  assertPinnedGraph(snapshot.graph);
  assert.equal(snapshot.graph.conditioning.inputs.resolution, 0);
  assert.deepEqual(snapshot.graph.sample.inputs.latent_image, ["conditioning", 2]);
  assert.deepEqual(snapshot.graph.conditioning.inputs["images.image_1"], ["edit_size", 0]);
  for (let i = 1; i < 10; i++) {
    assert.deepEqual(snapshot.graph[`reference_${i}_rgba`].inputs.alpha, [`reference_${i}`, 1]);
    assert.deepEqual(snapshot.graph.conditioning.inputs[`images.image_${i + 1}`], [`reference_${i}_bounded`, 0]);
    assert.equal(snapshot.graph[`reference_${i}_bounded`].inputs.megapixels, 1);
  }
});

test("Qwen source matching and protected edits avoid affected grids using padding and cropping only", () => {
  for (const setting of [
    { matchSource: true, sourceSize: { width: 1024, height: 1024 } },
    { mask, sourceSize: { width: 1024, height: 1024 } },
    { outpaint: { left: 128, right: 128, top: 128, bottom: 128 }, sourceSize: { width: 768, height: 768 } },
  ]) {
    const snapshot = compileGeneration({ ...editingRequest("qwen-image-2.1"), ...setting, quality: "high" });
    assertPinnedGraph(snapshot.graph);
    const g = snapshot.graph;
    assert.deepEqual([snapshot.parameters.width, snapshot.parameters.height], [1024, 1024]);
    assert.deepEqual([snapshot.parameters.samplingWidth, snapshot.parameters.samplingHeight], [1056, 1056]);
    const source = setting.outpaint ? "edit_padding" : "edit_size";
    assert.deepEqual(g.edit_sampling_padding.inputs, { image: [source, 0], left: 0, top: 0, right: 32, bottom: 32, feathering: 0 });
    assert.deepEqual(g.conditioning.inputs["images.image_1"], ["edit_sampling_padding", 0]);
    assert.deepEqual(g.edit_sampling_crop.inputs, { image: ["decode", 0], width: 1024, height: 1024, x: 0, y: 0 });
    assert.equal(g.edit_size.inputs.width, setting.sourceSize.width, "protected pixels cannot be stretched into the workaround margin");
    assert.equal(g.edit_size.inputs.height, setting.sourceSize.height);
    if (setting.matchSource) {
      assert.deepEqual(g.sample.inputs.latent_image, ["conditioning", 2]);
      assert.deepEqual(g.output.inputs.images, ["edit_sampling_crop", 0]);
    } else {
      const maskNode = setting.outpaint ? ["edit_padding", 1] : ["edit_mask", 0];
      assert.deepEqual(g.edit_sampling_protected.inputs.mask, maskNode);
      assert.deepEqual(g.edit_latent.inputs.mask, ["edit_sampling_mask", 0]);
      assert.deepEqual(g.edit_encode.inputs.pixels, ["edit_sampling_padding", 0]);
      assert.deepEqual(g.edit_composite.inputs.destination, [source, 0]);
      assert.deepEqual(g.edit_composite.inputs.source, ["edit_sampling_crop", 0]);
      assert.deepEqual(g.edit_composite.inputs.mask, maskNode);
    }
    assert.equal("output_resize" in g, false);
    verifySnapshot(snapshot);
  }
});

test("masked Ultra preserves native edit canvas and performs restoration after protected source composition", () => {
  const snapshot = compileGeneration({ ...editingRequest("sdxl-base"), mask, quality: "ultra" });
  assert.deepEqual([snapshot.parameters.width, snapshot.parameters.height], [1024, 768]);
  assert.deepEqual([snapshot.postprocess!.width, snapshot.postprocess!.height], [4096, 3072]);
  assert.deepEqual(snapshot.graph.ultra_source.inputs.image, ["edit_composite", 0]);
  const rebound = compileGeneration({ ...editingRequest("sdxl-base"), ...snapshot.parameters, mask }, snapshot.model, snapshot.postprocess!.model, snapshot.extensions);
  assert.equal(rebound.hash, snapshot.hash);
});

test("Ideogram SDEdit trims native sigmas before exact final polish, and experimental reference uses a bounded diptych", () => {
  const edited = compileGeneration({ ...editingRequest("ideogram-4-fp8"), denoise: .65 });
  assertPinnedGraph(edited.graph);
  assert.equal(edited.graph.latent.class_type, "VAEEncode");
  assert.equal(edited.graph.denoise_schedule.inputs.denoise, .65);
  assert.deepEqual(edited.graph.polish_schedule.inputs.sigmas, ["denoise_schedule", 1]);
  assert.equal(edited.graph.polish_schedule.inputs.step, 11);
  const reference = compileGeneration({ ...base, modelId: "ideogram-4-fp8", operation: "reference", images: [image], quality: "high" });
  assertPinnedGraph(reference.graph);
  assert.deepEqual([reference.parameters.width, reference.parameters.height], [1024, 1024]);
  assert.deepEqual([reference.parameters.samplingWidth, reference.parameters.samplingHeight], [2048, 1024]);
  assert.equal(reference.graph.schedule.inputs.width, 2048);
  assert.deepEqual(reference.graph.sample.inputs.latent_image, ["reference_latent", 0]);
  assert.deepEqual(reference.graph.reference_crop.inputs, { image: ["decode", 0], width: 1024, height: 1024, x: 1024, y: 0 });
  assert.deepEqual(reference.graph.output.inputs.images, ["reference_crop", 0]);
});

test("native quality profiles retain explicit overrides and Ideogram uses exact publisher polish step counts", () => {
  for (const [quality, steps, final, mu, std] of [["fast", 12, 1, .5, 1.75], ["standard", 20, 2, 0, 1.75], ["high", 48, 3, 0, 1.5]] as const) {
    const s = compileGeneration({ ...base, modelId: "ideogram-4-fp8", quality });
    assert.equal(s.parameters.steps, steps);
    assert.equal(s.graph.schedule.inputs.mu, mu); assert.equal(s.graph.schedule.inputs.std, std);
    assert.equal(s.graph.polish_schedule.inputs.step, steps - final);
    assert.equal(s.graph.guider.inputs.cfg, 7); assert.equal(s.graph.polish.inputs.cfg, 3);
    assert.equal(s.graph.polish_noise.class_type, "DisableNoise");
    assert.deepEqual(s.graph.sample_polish.inputs.latent_image, ["sample", 0]);
    assertPinnedGraph(s.graph);
  }
  for (const modelId of editingModels) assert.equal(compileGeneration({ ...base, modelId, quality: "high", steps: 7 }).parameters.steps, 7);
});

test("quality presets fit native canvases as well as sampling without resizing a source edit or Ideogram reference", () => {
  for (const model of DEFAULT_MODELS) for (const quality of ["fast", "standard", "high"] as const) {
    const snapshot = compileGeneration({ ...base, modelId: model.id, quality, width: 1024, height: 768 });
    assert.deepEqual({ width: snapshot.parameters.width, height: snapshot.parameters.height }, qualityImageSize(model, 1024, 768, quality));
    assert.equal(snapshot.parameters.steps, FAMILY_RECIPES[model.familyId].qualityPresets.find(item => item.id === quality)!.sampling!.steps);
    const replay = compileGeneration({ ...base, modelId: model.id, quality, width: snapshot.parameters.width, height: snapshot.parameters.height });
    assert.equal(replay.hash, snapshot.hash, "fitted quality canvases must not drift");
  }
  for (const modelId of editingModels) for (const quality of ["fast", "standard", "high", "ultra"] as const) {
    for (const setting of [{ matchSource: true }, { mask }, { outpaint: { left: 128, right: 0, top: 0, bottom: 0 } }]) {
      const snapshot = compileGeneration({ ...editingRequest(modelId), quality, ...setting });
      assert.deepEqual([snapshot.parameters.width, snapshot.parameters.height], [setting.outpaint ? 1152 : 1024, 768]);
    }
    const reference = compileGeneration({ ...base, modelId: "ideogram-4-fp8", operation: "reference", images: [image], quality });
    assert.deepEqual([reference.parameters.width, reference.parameters.height], [1024, 1024]);
    assert.deepEqual([reference.parameters.samplingWidth, reference.parameters.samplingHeight], [2048, 1024]);
  }
});

test("Ideogram final polish follows native Python rounding for partial denoise schedules", () => {
  for (const [steps, denoise, retained] of [[20, .625, 12], [20, .675, 14], [25, .5, 12], [27, .5, 14]] as const) {
    const snapshot = compileGeneration({ ...editingRequest("ideogram-4-fp8"), steps, denoise });
    const polishSteps = Math.max(1, Math.round(steps * 2 / 20));
    assert.equal(snapshot.graph.polish_schedule.inputs.step, retained - polishSteps);
  }
  assert.throws(() => compileGeneration({ ...editingRequest("ideogram-4-fp8"), steps: 1, denoise: .5 }), /at least one sampling step/);
});

test("Krea style references require the pinned adapter and native multimodal conditioning", () => {
  const snapshot = compileGeneration({ ...base, modelId: "krea-2-turbo", operation: "reference", images: [image, { ...image, filename: "style2.png" }], referenceStrength: .7 });
  assertPinnedGraph(snapshot.graph);
  assert.equal(snapshot.graph.positive.class_type, "TextEncodeQwenImageEditPlus");
  assert.equal(snapshot.graph.style_adapter.inputs.strength_model, .7);
  assert.equal(snapshot.graph.style_conditioning.inputs.reference_latents_method, "index_timestep_zero");
  assert.equal(snapshot.graph.style_sampling.class_type, "ModelSamplingFlux");
  assert.deepEqual(snapshot.extensions!.map(item => item.id), ["krea2-style-reference"]);
  assert.equal(snapshot.auxiliaryArtifacts![0].folder, "loras");
  assert.throws(() => compileGeneration({ ...base, modelId: "krea-2-turbo", operation: "reference", images: [image, image, image] }), /Too many/);
});

test("SDXL ReVision chains all image conditioning and optional refiner continues the same noisy latent", () => {
  const snapshot = compileGeneration({ ...base, operation: "reference", images: [image, image, image, image], referenceStrength: .8, refiner: true, steps: 40 });
  assertPinnedGraph(snapshot.graph);
  assert.equal(snapshot.graph.revision_3.inputs.strength, .8);
  assert.deepEqual(snapshot.graph.revision_3.inputs.conditioning, ["revision_2", 0]);
  assert.deepEqual(snapshot.graph.sample.inputs.positive, ["revision_3", 0]);
  assert.equal(snapshot.graph.sample.class_type, "KSamplerAdvanced");
  assert.equal(snapshot.graph.sample.inputs.end_at_step, 32);
  assert.equal(snapshot.graph.sample.inputs.return_with_leftover_noise, "enable");
  assert.equal(snapshot.graph.refiner_sample.inputs.add_noise, "disable");
  assert.deepEqual(snapshot.graph.refiner_sample.inputs.latent_image, ["sample", 0]);
  assert.deepEqual(snapshot.graph.decode.inputs.samples, ["refiner_sample", 0]);
  assert.deepEqual(snapshot.extensions!.map(item => item.id), ["sdxl-refiner-1.0", "sdxl-clip-vision"]);
});

test("SDXL refinement preserves image-to-image denoise strength and requested sampling budget", () => {
  for (const denoise of [1, .65, .2, .01]) {
    const snapshot = compileGeneration({ ...editingRequest("sdxl-base"), refiner: true, steps: 40, denoise });
    const total = Math.floor(40 / denoise), start = total - 40;
    assert.equal(snapshot.parameters.steps, 40);
    assert.equal(snapshot.graph.sample.inputs.steps, total);
    assert.equal(snapshot.graph.sample.inputs.start_at_step, start);
    assert.equal(snapshot.graph.sample.inputs.end_at_step, start + 32);
    assert.equal(snapshot.graph.refiner_sample.inputs.start_at_step, start + 32);
    assert.equal(snapshot.graph.refiner_sample.inputs.end_at_step, total);
    assert.equal(snapshot.graph.refiner_sample.inputs.steps, total);
    assertPinnedGraph(snapshot.graph);
  }
  assert.throws(() => compileGeneration({ ...editingRequest("sdxl-base"), refiner: true, steps: 100, denoise: .001 }), /Increase denoise strength/);
});

function importedLora(familyId: GenerationExtensionManifest["familyIds"][number]): GenerationExtensionManifest {
  return { id: "my-lora", revision: "sha-v1", name: "My adapter", description: "Imported adapter", kind: "lora", category: "image", familyIds: [familyId], memory: { ramBytes: 2 ** 30, vramBytes: 2 ** 30 }, artifacts: [{ role: "lora", folder: "loras", filename: "private/adapter.safetensors", sha256: "a".repeat(64), source: "https://huggingface.co/author/repo/resolve/abcdef/model.safetensors" }] };
}

test("official and imported LoRAs use pinned family-compatible files, survive replay and change hashes", () => {
  for (const modelId of ["sdxl-base", "krea-2-turbo", "flux-2-klein-4b", "qwen-image-2.1"]) {
    const model = getModel(modelId), extension = importedLora(model.familyId);
    const request = { ...base, modelId, loras: [{ id: extension.id, strength: .6 }] };
    const snapshot = compileGeneration(request, model, undefined, [extension]);
    assertPinnedGraph(snapshot.graph);
    assert.equal(snapshot.graph.lora_0.class_type, model.familyId === "sdxl" ? "LoraLoader" : "LoraLoaderModelOnly");
    assert.equal(snapshot.graph.lora_0.inputs.strength_model, .6);
    assert.equal(snapshot.extensions![0].artifacts[0].filename, "private/adapter.safetensors");
    assert.equal(compileGeneration(request, snapshot.model, undefined, snapshot.extensions).hash, snapshot.hash);
    extension.artifacts[0].filename = "changed.safetensors";
    assert.equal(snapshot.extensions![0].artifacts[0].filename, "private/adapter.safetensors");
    assert.notEqual(compileGeneration({ ...request, loras: [{ id: "my-lora", strength: .5 }] }, model, undefined, snapshot.extensions).hash, snapshot.hash);
  }
  const style = compileGeneration({ ...base, modelId: "krea-2-turbo", loras: [{ id: "krea2-darkbrush", strength: 1 }] });
  assert.match(String(style.graph.positive.inputs.text), /^monochrome ink wash style/);
  for (const item of GENERATION_EXTENSIONS) {
    validateGenerationExtension(item);
    assert.match(item.artifacts[0].sha256!, /^[a-f0-9]{64}$/);
    assert.match(item.artifacts[0].source!, /\/resolve\/[a-f0-9]{40}\//);
  }
});

test("strict editing validation rejects missing source metadata, unsafe masks, wrong operations and unbounded extensions", () => {
  const edit = editingRequest("sdxl-base");
  for (const patch of [{ mask, sourceSize: undefined }, { mask: { ...mask, filename: "../private.png" } }, { mask, outpaint: { left: 8, right: 0, top: 0, bottom: 0 } }, { outpaint: { left: 0, right: 0, top: 0, bottom: 0 } }, { outpaint: { left: 7, right: 0, top: 0, bottom: 0 } }, { refiner: true, steps: 1 }, { referenceStrength: .5 }, { matchSource: "yes" }, { loras: [{ id: "krea2-darkbrush", strength: 1 }] }]) assert.throws(() => compileGeneration({ ...edit, ...patch } as GenerationRequest));
  assert.throws(() => compileGeneration({ ...editingRequest("ideogram-4-fp8"), operation: "reference", mask }), /does not support/);
  assert.throws(() => compileGeneration({ ...editingRequest("krea-2-turbo"), mask }), /does not support/);
  assert.throws(() => compileGeneration({ ...base, matchSource: true, sourceSize }), /Source matching/);
  const extension = importedLora("sdxl");
  for (const extensions of [[], [extension, extension], [{ ...extension, familyIds: ["krea-2"] }], [{ ...extension, artifacts: [{ ...extension.artifacts[0], filename: "../bad" }] }]]) assert.throws(() => compileGeneration({ ...base, loras: [{ id: extension.id, strength: 1 }] }, undefined, undefined, extensions as GenerationExtensionManifest[]));
  assert.throws(() => validateGenerationExtension(importedLora("ideogram-4")), /dual-model/);
});
