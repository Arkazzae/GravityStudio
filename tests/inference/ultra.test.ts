import assert from "node:assert/strict";
import { test } from "node:test";
import backgroundInfo from "./fixtures/background-object-info.json" with { type: "json" };
import upscaleInfo from "./fixtures/upscale-object-info.json" with { type: "json" };
import {
  BIREFNET_ARTIFACT, DEFAULT_MODELS, FAMILY_RECIPES, checkCapabilities, compileGeneration,
  compileUpscale, getModel, getUpscaler, verifySnapshot,
} from "../../packages/inference/index.ts";
import type {
  ComfyDiscovery, FamilyId, GenerationRequest, GenerationSnapshot, ModelManifest, NodeInfo,
} from "../../packages/inference/index.ts";
import { sdxlObjectInfo } from "./fake-comfy.ts";

const base = { modelId: "sdxl-base", prompt: "A ceramic cup on a table", seed: 42 };
const ultra = { ...base, quality: "ultra" as const };
const reference = { filename: "reference.png", subfolder: "queued", type: "input" as const };
const aspects = ["1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4", "21:9"];

// Pin the existing High canvases independently of the compiler's size helper.
// In particular, a grid-fitted 16:9 canvas need not be mathematically exact 16:9.
const highCanvases: Record<FamilyId, readonly (readonly [number, number])[]> = {
  sdxl: [[1024, 1024], [1248, 832], [832, 1248], [1368, 768], [768, 1368], [1184, 888], [888, 1184], [1568, 672]],
  "flux-2-klein-4b": [[1440, 1440], [1728, 1152], [1152, 1728], [1904, 1072], [1072, 1904], [1664, 1248], [1248, 1664], [2048, 880]],
  "flux-2-klein-9b": [[1440, 1440], [1728, 1152], [1152, 1728], [1904, 1072], [1072, 1904], [1664, 1248], [1248, 1664], [2048, 880]],
  "krea-2": [[2048, 2048], [2016, 1344], [1344, 2016], [2048, 1152], [1152, 2048], [2048, 1536], [1536, 2048], [2048, 880]],
  "qwen-image-2.1": [[2048, 2048], [2496, 1664], [1664, 2496], [2720, 1536], [1536, 2720], [2304, 1728], [1728, 2304], [3136, 1344]],
  "ideogram-4": [[2048, 2048], [2016, 1344], [1344, 2016], [2048, 1152], [1152, 2048], [2048, 1536], [1536, 2048], [2048, 880]],
};

function familyModels(): ModelManifest[] {
  // Klein 9B is supported by the compiler but is not a bundled checkpoint.
  const klein9 = { ...getModel("flux-2-klein-4b"), id: "test-klein-9b", familyId: "flux-2-klein-9b" as const };
  return [...DEFAULT_MODELS.map(model => structuredClone(model)), klein9];
}

function discovery(): ComfyDiscovery {
  // Merge the small generation fixture with captured native restoration and
  // compositing schemas. Only model inventories are supplied by this test.
  const objectInfo = structuredClone({ ...sdxlObjectInfo, ...backgroundInfo, ...upscaleInfo }) as Record<string, NodeInfo>;
  const models: ComfyDiscovery["models"] = {};
  for (const artifact of [...getModel(base.modelId).artifacts, ...getUpscaler("seedvr2-7b").artifacts, BIREFNET_ARTIFACT]) {
    (models[artifact.folder] ??= []).push(artifact.filename);
  }
  objectInfo.UNETLoader.input!.required!.unet_name = [models.diffusion_models];
  objectInfo.VAELoader.input!.required!.vae_name = [models.vae];
  return { objectInfo, models, modelSources: {} };
}

test("Ultra retains every family's High aspect presets and produces an even 4096-pixel longest edge", () => {
  for (const model of familyModels()) {
    const family = FAMILY_RECIPES[model.familyId];
    for (const [index, [width, height]] of highCanvases[model.familyId].entries()) {
      const context = `${model.id} ${aspects[index]}`;
      const snapshot = compileGeneration({ ...ultra, modelId: model.id, width, height }, model);
      verifySnapshot(snapshot);
      assert.deepEqual([snapshot.parameters.width, snapshot.parameters.height], [width, height], context);
      assert.equal(snapshot.parameters.quality, "ultra");
      assert.equal(snapshot.recipe.operation, "text-to-image");
      assert.equal(snapshot.recipe.familyId, model.familyId);
      assert.equal(width % family.dimensions.multiple, 0);
      assert.equal(height % family.dimensions.multiple, 0);
      assert(width * height <= family.dimensions.maxPixels);
      assert(snapshot.postprocess);
      const output = snapshot.postprocess;
      assert.equal(output.model.id, "seedvr2-7b");
      assert.equal(Math.max(output.width, output.height), 4096, context);
      assert.equal(output.width % 2, 0, context);
      assert.equal(output.height % 2, 0, context);
      const shortSide = Math.min(width, height) * 4096 / Math.max(width, height);
      assert(Math.abs(Math.min(output.width, output.height) - shortSide) <= 1, `${context}: round only to the nearest even pixel`);
      assert.equal(snapshot.graph.ultra_resize.inputs.width, output.width);
      assert.equal(snapshot.graph.ultra_resize.inputs.height, output.height);
      assert.equal(snapshot.graph.ultra_resize.inputs.crop, "disabled");
      assert.deepEqual(Object.entries(snapshot.graph).filter(([, node]) => node.class_type === "SaveImage").map(([id]) => id), ["output"]);
      assert.deepEqual(snapshot.outputs, [{ node: "output", field: "images" }]);
    }
  }
});

test("Ultra promotes ordinary and custom canvases to High without changing generation sampling controls", () => {
  for (const model of familyModels()) {
    const snapshot = compileGeneration({ ...ultra, modelId: model.id }, model);
    assert.deepEqual([snapshot.parameters.width, snapshot.parameters.height], highCanvases[model.familyId][0], model.id);
    const ordinary = compileGeneration({ ...base, modelId: model.id }, model);
    for (const key of ["steps", "cfg", "sampler", "scheduler", "clipSkip", "seed", "denoise"] as const) {
      assert.equal(snapshot.parameters[key], ordinary.parameters[key], `${model.id} ${key}`);
    }
    const custom = compileGeneration({ ...ultra, modelId: model.id, width: 1216, height: 1024 }, model);
    assert(Math.abs(custom.parameters.width / custom.parameters.height / (1216 / 1024) - 1) <= .02, model.id);
    const rebound = compileGeneration({ ...ultra, modelId: model.id, width: custom.parameters.width, height: custom.parameters.height }, custom.model, custom.postprocess!.model);
    assert.equal(rebound.hash, custom.hash, `${model.id}: saved High dimensions must not drift when compiled again`);
  }
});

test("native Qwen High above 2048 bypasses only the manual-upscale source limit", () => {
  const snapshot = compileGeneration({ ...ultra, modelId: "qwen-image-2.1", width: 2720, height: 1536 });
  assert.deepEqual([snapshot.parameters.width, snapshot.parameters.height], [2720, 1536]);
  assert.deepEqual([snapshot.postprocess!.width, snapshot.postprocess!.height], [4096, 2314]);
  assert(!Object.values(snapshot.graph).some(node => node.class_type === "LoadImage"));
  assert.throws(() => compileUpscale({ modelId: "seedvr2-7b", scale: 2, sourceWidth: 2720, sourceHeight: 1536, image: reference }), { code: "INVALID_INPUT" });
});

test("Ultra restores RGB after background processing and rejoins the original inverse alpha at final size", () => {
  for (const modelId of ["sdxl-base", "qwen-image-2.1"]) for (const background of ["auto", "opaque", "transparent"] as const) {
    const ordinary = compileGeneration({ ...base, modelId, background });
    const snapshot = compileGeneration({ ...ultra, modelId, background });
    const { graph } = snapshot;
    assert.equal(graph.ultra_source.class_type, "SplitImageWithAlpha");
    assert.deepEqual(graph.ultra_source.inputs.image, ordinary.graph.output.inputs.images, `${modelId} ${background}: use the final background-processed image`);
    assert.deepEqual(graph.ultra_resize.inputs.image, ["ultra_source", 0]);
    assert.deepEqual(graph.ultra_alpha.inputs, { image: ["ultra_postprocess", 0], alpha: ["ultra_source", 1] });
    assert.deepEqual(graph.output.inputs.images, ["ultra_alpha", 0]);
    assert(!Object.entries(graph).some(([id, node]) => id.startsWith("ultra_") && node.class_type === "InvertMask"));
    const cutout = modelId === "sdxl-base" && background === "transparent";
    assert.equal(snapshot.auxiliaryArtifacts!.some(artifact => artifact.role === "background-removal"), cutout);
    assert.equal(snapshot.auxiliaryArtifacts!.length, cutout ? 3 : 2);
    if (cutout) assert.deepEqual(graph.ultra_source.inputs.image, ["background_rgba", 0]);
    if (modelId === "qwen-image-2.1" && background === "opaque") assert.deepEqual(graph.ultra_source.inputs.image, ["background_opaque", 0]);
  }
});

test("the composed graph keeps native Seed conditioning, one-step sampling and tiled VAE independent of generation", () => {
  const { graph } = compileGeneration({ ...ultra, steps: 35, cfg: 6 });
  assert.equal(graph.sample.inputs.steps, 35);
  assert.equal(graph.sample.inputs.cfg, 6);
  assert.deepEqual(graph.ultra_sample.inputs, {
    model: ["ultra_model", 0], positive: ["ultra_conditioning", 0], negative: ["ultra_conditioning", 1],
    latent_image: ["ultra_encode", 0], seed: 42, steps: 1, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1,
  });
  assert.deepEqual(graph.ultra_conditioning.inputs, { model: ["ultra_model", 0], vae_conditioning: ["ultra_encode", 0] });
  assert.deepEqual(graph.ultra_encode.inputs.pixels, ["ultra_preprocess", 0]);
  assert.deepEqual(graph.ultra_decode.inputs.samples, ["ultra_sample", 0]);
  for (const node of [graph.ultra_encode, graph.ultra_decode]) {
    assert.deepEqual(node.inputs.vae, ["ultra_vae", 0]);
    assert.equal(node.inputs.tile_size, 512);
    assert.equal(node.inputs.overlap, 128);
    assert.equal(node.inputs.temporal_size, 4096);
    assert.equal(node.inputs.temporal_overlap, 8);
  }
  assert.deepEqual(graph.ultra_postprocess.inputs, { images: ["ultra_decode", 0], original_resized_images: ["ultra_resize", 0], color_correction_method: "lab" });
  assert(!Object.entries(graph).some(([id, node]) => id.startsWith("ultra_") && /CLIP|TextEncode|LoadImage/.test(node.class_type)));
});

test("Ultra snapshots detach pinned models and rebind uploaded references without adopting later manifests", () => {
  const model = getModel(base.modelId);
  const upscaler = getUpscaler("seedvr2-7b");
  upscaler.revision = "archived-recipe";
  upscaler.artifacts[0].filename = "archive/seedvr2_7b_fp16.safetensors";
  const request: GenerationRequest = { ...ultra, operation: "image-to-image", width: 768, height: 512, denoise: .4, images: [structuredClone(reference)] };
  const snapshot = compileGeneration(request, model, upscaler);
  assert.equal(compileGeneration({ ...request }, model, upscaler).hash, snapshot.hash);
  verifySnapshot(JSON.parse(JSON.stringify(snapshot)));
  model.artifacts[0].filename = "later-generation.safetensors";
  upscaler.artifacts[0].filename = "later-restoration.safetensors";
  upscaler.memory.vramBytes++;
  request.images![0].subfolder = "worker/upload";
  assert.equal(snapshot.inputs[0].subfolder, "queued");
  assert.equal(snapshot.model.artifacts[0].filename, "sd_xl_base_1.0.safetensors");
  assert.equal(snapshot.postprocess!.model.artifacts[0].filename, "archive/seedvr2_7b_fp16.safetensors");
  const rebound = compileGeneration(request, snapshot.model, snapshot.postprocess!.model);
  assert.notEqual(rebound.hash, snapshot.hash);
  assert.equal(rebound.graph.input_image.inputs.image, "worker/upload/reference.png");
  assert.deepEqual(rebound.postprocess, snapshot.postprocess);
  assert.deepEqual(rebound.auxiliaryArtifacts, snapshot.auxiliaryArtifacts);
  assert.equal(rebound.graph.ultra_model.inputs.unet_name, "archive/seedvr2_7b_fp16.safetensors");
  assert.equal(rebound.parameters.denoise, .4);
  assert.equal(rebound.graph.ultra_sample.inputs.denoise, 1);
  assert.notEqual(compileGeneration(request, snapshot.model).hash, rebound.hash, "Omitting the archived upscaler would silently change the recipe");
  verifySnapshot(rebound);
});

test("the snapshot hash covers Ultra target dimensions, weights, auxiliary artifacts and graph", () => {
  const snapshot = compileGeneration(ultra);
  const mutations: ((copy: GenerationSnapshot) => void)[] = [
    copy => { copy.postprocess!.width -= 2; },
    copy => { copy.postprocess!.model.artifacts[0].sha256 = "f".repeat(64); },
    copy => { copy.auxiliaryArtifacts![0].filename = "different.safetensors"; },
    copy => { copy.graph.ultra_sample.inputs.seed = 43; },
    copy => { delete copy.parameters.quality; },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(snapshot);
    mutate(copy);
    assert.throws(() => verifySnapshot(copy), { code: "INVALID_SNAPSHOT" });
  }
});

test("Ultra validates the whole composed graph and all restoration files against captured native schemas", () => {
  for (const background of ["auto", "transparent"] as const) {
    const snapshot = compileGeneration({ ...ultra, background });
    assert.deepEqual(checkCapabilities(snapshot, discovery()), { available: true, issues: [], integrity: "filenames-only" });
    for (const artifact of [...getModel(base.modelId).artifacts, ...snapshot.auxiliaryArtifacts!]) {
      const found = discovery();
      found.models[artifact.folder] = found.models[artifact.folder]!.filter(filename => filename !== artifact.filename);
      const result = checkCapabilities(snapshot, found);
      assert.equal(result.available, false);
      assert(result.issues.some(issue => issue.code === "MISSING_MODEL" && issue.message.includes(artifact.filename)));
    }
    for (const name of ["SeedVR2Conditioning", "VAEEncodeTiled", "SplitImageWithAlpha", "CLIPTextEncode"]) {
      const found = discovery();
      delete found.objectInfo[name];
      assert(checkCapabilities(snapshot, found).issues.some(issue => issue.code === "MISSING_NODE" && issue.message.includes(name)));
    }
    const incompatible = discovery();
    incompatible.objectInfo.SeedVR2PostProcessing.input!.required!.color_correction_method = ["COMBO", { options: ["none"] }];
    assert(checkCapabilities(snapshot, incompatible).issues.some(issue => issue.code === "INVALID_NODE_INPUT" && issue.node === "ultra_postprocess"));
  }
});

test("ordinary generation retains requested dimensions and has no Ultra requirements or snapshot fields", () => {
  for (const model of familyModels()) {
    const request = { ...base, modelId: model.id, width: 768, height: 768 };
    const snapshot = compileGeneration(request, model);
    assert.equal(snapshot.hash, compileGeneration({ ...request, quality: undefined }, model).hash);
    assert.deepEqual([snapshot.parameters.width, snapshot.parameters.height], [768, 768]);
    assert.equal(Object.hasOwn(snapshot, "postprocess"), false);
    assert.equal(Object.hasOwn(snapshot, "auxiliaryArtifacts"), false);
    assert.equal(Object.hasOwn(snapshot.parameters, "quality"), false);
    assert(!Object.keys(snapshot.graph).some(id => id.startsWith("ultra_")));
  }
  const cutout = compileGeneration({ ...base, background: "transparent" });
  assert.deepEqual(cutout.auxiliaryArtifacts, [BIREFNET_ARTIFACT]);
  const found = discovery();
  delete found.models.diffusion_models;
  delete found.models.vae;
  delete found.objectInfo.SeedVR2Conditioning;
  assert.equal(checkCapabilities(cutout, found).available, true);
});

test("invalid quality, unsafe dimensions and alternative upscalers cannot silently enable a different Ultra recipe", () => {
  for (const quality of ["high", "Ultra", "ultra-quality", "", null, false, 1, {}]) {
    assert.throws(() => compileGeneration({ ...base, quality } as GenerationRequest), { code: "INVALID_INPUT" });
  }
  for (const patch of [{ width: 0 }, { width: 1025 }, { width: 4096 }, { height: Infinity }, { height: 768.5 }, { postprocess: { modelId: "nomos2-hq" } }]) {
    assert.throws(() => compileGeneration({ ...ultra, ...patch } as GenerationRequest), { code: "INVALID_INPUT" });
  }
  for (const modelId of ["seedvr2-3b", "nomos2-hq"]) {
    assert.throws(() => compileGeneration(ultra, undefined, getUpscaler(modelId)), { code: "INVALID_MODEL" });
  }
});
