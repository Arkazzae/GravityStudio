import assert from "node:assert/strict";
import { test } from "node:test";
import objectInfo from "./fixtures/upscale-object-info.json" with { type: "json" };
import { checkCapabilities, ComfyClient, compileGeneration, compileUpscale, getUpscaler, isUpscaleSnapshot, UPSCALER_MODELS, validateUpscaler, verifySnapshot } from "../../packages/inference/index.ts";
import type { ComfyDiscovery, InputImage, NodeInfo, UpscaleRequest } from "../../packages/inference/index.ts";
import { fakeComfy } from "./fake-comfy.ts";

const image: InputImage = { filename: "source.png", subfolder: "grav/input", type: "input" };
const request: UpscaleRequest = { modelId: "nomos2-hq", scale: 2, sourceWidth: 257, sourceHeight: 383, image, seed: 42 };

// Captured from the pinned v0.39.0 worker's /object_info. Only dynamic model
// inventories are populated here; node inputs, enums and limits stay as captured.
function discovery(): ComfyDiscovery {
  const info = structuredClone(objectInfo) as Record<string, NodeInfo>;
  const models: ComfyDiscovery["models"] = {};
  for (const artifact of UPSCALER_MODELS.flatMap(model => model.artifacts)) {
    const files = models[artifact.folder] ??= [];
    if (!files.includes(artifact.filename)) files.push(artifact.filename);
  }
  info.UpscaleModelLoader.input!.required!.model_name = ["COMBO", { options: models.upscale_models }];
  info.UNETLoader.input!.required!.unet_name = [models.diffusion_models];
  info.VAELoader.input!.required!.vae_name = [models.vae];
  return { objectInfo: info, models, modelSources: {} };
}

test("all native upscale recipes match captured ComfyUI schemas for both exact output scales", () => {
  const found = discovery();
  assert.deepEqual(UPSCALER_MODELS.map(model => model.id), ["nomos2-hq", "seedvr2-3b", "seedvr2-7b"]);
  for (const model of UPSCALER_MODELS) for (const scale of model.scales) {
    const snapshot = compileUpscale({ ...request, modelId: model.id, scale });
    verifySnapshot(snapshot);
    assert(isUpscaleSnapshot(snapshot));
    assert.equal(snapshot.recipe.operation, "upscale");
    assert.equal(snapshot.parameters.width, 257 * scale);
    assert.equal(snapshot.parameters.height, 383 * scale);
    assert.deepEqual(snapshot.graph.resize.inputs.width, 257 * scale);
    assert.deepEqual(snapshot.graph.resize.inputs.height, 383 * scale);
    assert.deepEqual(checkCapabilities(snapshot, found), { available: true, issues: [], integrity: "filenames-only" });
    assert.deepEqual(snapshot.outputs, [{ node: "output", field: "images" }]);
  }
  assert.equal(isUpscaleSnapshot(compileGeneration({ modelId: "sdxl-base", prompt: "A cup", seed: 42 })), false);
});

test("Nomos restores at native 4× before requested sizing and source alpha is joined only at final size", () => {
  for (const model of UPSCALER_MODELS) {
    const { graph } = compileUpscale({ ...request, modelId: model.id });
    assert.equal(graph.alpha.class_type, "JoinImageWithAlpha");
    assert.deepEqual(graph.alpha.inputs.alpha, ["input_image", 1], "LoadImage already supplies inverted alpha; a second inversion would erase opaque content");
    assert.deepEqual(graph.output.inputs.images, ["alpha", 0]);
    assert.equal(graph.resize.inputs.crop, "disabled");
    if (model.familyId === "nomos2") {
      assert.equal(graph.upscale_model.class_type, "UpscaleModelLoader");
      assert.equal(graph.upscale.class_type, "ImageUpscaleWithModel");
      assert.deepEqual(graph.resize.inputs.image, ["upscale", 0]);
      assert.deepEqual(graph.alpha.inputs.image, ["resize", 0]);
      assert.equal(graph.sample, undefined);
    } else assert.deepEqual(graph.alpha.inputs.image, ["postprocess", 0]);
    assert(!Object.values(graph).some(node => node.class_type === "InvertMask"));
  }
});

test("SeedVR2 uses embedded native conditioning, one Euler step and tiled VAE without a text encoder", () => {
  for (const modelId of ["seedvr2-3b", "seedvr2-7b"]) {
    const { graph } = compileUpscale({ ...request, modelId });
    assert.equal(graph.preprocess.class_type, "SeedVR2Preprocess");
    assert.deepEqual(graph.encode.inputs.pixels, ["preprocess", 0]);
    assert.deepEqual(graph.conditioning.inputs, { model: ["model", 0], vae_conditioning: ["encode", 0] });
    assert.deepEqual(graph.sample.inputs, { model: ["model", 0], positive: ["conditioning", 0], negative: ["conditioning", 1], latent_image: ["encode", 0], seed: 42, steps: 1, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 });
    for (const node of [graph.encode, graph.decode]) {
      assert.equal(node.inputs.tile_size, 512);
      assert.equal(node.inputs.overlap, 128);
      assert.equal(node.inputs.temporal_size, 4096);
      assert.equal(node.inputs.temporal_overlap, 8);
    }
    assert.deepEqual(graph.postprocess.inputs.original_resized_images, ["resize", 0], "The unpadded requested canvas removes preprocessing padding after decoding");
    assert.equal(graph.postprocess.inputs.color_correction_method, "lab");
    assert(!Object.values(graph).some(node => /CLIP|TextEncode|SeedVR2VideoUpscaler/.test(node.class_type)));
  }
});

test("upscaler files are pinned, native Seed DiTs include conditioning, and both variants share one VAE", () => {
  for (const model of UPSCALER_MODELS) for (const artifact of model.artifacts) {
    assert.match(artifact.source!, /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[a-f0-9]{40}\/.+\.safetensors$/);
    assert.match(artifact.sha256!, /^[a-f0-9]{64}$/);
  }
  const small = getUpscaler("seedvr2-3b"), large = getUpscaler("seedvr2-7b");
  assert.equal(small.artifacts[0].sha256, "98669fd2c06df5eca88baf68cd5c478775c8e61fc110e598c52b350145ea2660");
  assert.equal(large.artifacts[0].sha256, "2742ca6fee63bc5cc1773f426dd4b07b78cad27f51c9ea5cd42b035e6b592252");
  assert.deepEqual(small.artifacts[1], large.artifacts[1]);
  assert.equal(small.artifacts[1].sha256, "20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1");
});

test("snapshots freeze manifest and inputs, have stable hashes, and preserve a pinned model during worker rebinding", () => {
  const model = getUpscaler("nomos2-hq");
  const input = structuredClone(request);
  const snapshot = compileUpscale(input, model);
  assert.equal(compileUpscale({ ...input, seed: undefined }, model).hash, snapshot.hash);
  model.artifacts[0].filename = "new-catalog-file.safetensors";
  input.image.subfolder = "later-upload";
  assert.equal(snapshot.model.artifacts[0].filename, "4xNomos2_hq_drct-l.safetensors");
  assert.equal(snapshot.inputs[0].subfolder, "grav/input");
  assert.notEqual(compileUpscale(request, model).hash, snapshot.hash);
  assert.equal(compileUpscale(request, snapshot.model).hash, snapshot.hash);
  const rebound = compileUpscale(input, snapshot.model);
  assert.notEqual(rebound.hash, snapshot.hash);
  assert.equal(rebound.graph.input_image.inputs.image, "later-upload/source.png");
  assert.deepEqual(rebound.model.artifacts, snapshot.model.artifacts);
  snapshot.parameters.width++;
  assert.throws(() => verifySnapshot(snapshot), { code: "INVALID_SNAPSHOT" });
});

test("invalid, unsafe or oversized upscale requests fail rather than silently reducing the scale", () => {
  for (const change of [
    { scale: 1 }, { scale: 3 }, { scale: "2" }, { scale: null }, { sourceWidth: 0 }, { sourceHeight: -1 },
    { sourceWidth: 2049 }, { sourceHeight: 256.5 }, { sourceWidth: NaN }, { sourceHeight: Infinity },
    { scale: 4, sourceWidth: 1025 }, { seed: -1 }, { seed: 1.5 }, { seed: Number.MAX_SAFE_INTEGER + 1 },
    { prompt: "not an upscale parameter" }, { image: { ...image, filename: "../secret.png" } },
    { image: { ...image, subfolder: "../secret" } }, { image: { ...image, type: "output" } },
  ]) assert.throws(() => compileUpscale({ ...request, ...change } as UpscaleRequest), { code: "INVALID_INPUT" });
  assert.throws(() => compileUpscale({ ...request, modelId: "unlisted" }), { code: "MODEL_NOT_FOUND" });
  assert.throws(() => compileUpscale(request, getUpscaler("seedvr2-3b")), { code: "INVALID_INPUT" });
  assert.doesNotThrow(() => compileUpscale({ ...request, sourceWidth: 2048, sourceHeight: 2048 }));
  assert.doesNotThrow(() => compileUpscale({ ...request, scale: 4, sourceWidth: 1024, sourceHeight: 1024 }));
  for (const patch of [
    { scales: [8] }, { maxOutputDimension: 8192 }, { memory: { ramBytes: 0, vramBytes: 1 } },
    { artifacts: [{ ...getUpscaler("nomos2-hq").artifacts[0], filename: "../../outside.safetensors" }] },
    { artifacts: [{ ...getUpscaler("nomos2-hq").artifacts[0], folder: "diffusion_models" }] },
  ]) assert.throws(() => validateUpscaler({ ...getUpscaler("nomos2-hq"), ...patch } as never), { code: "INVALID_MODEL" });
});

test("tiny and narrow inputs retain their exact requested canvas while native nodes handle padding", () => {
  for (const model of UPSCALER_MODELS) for (const scale of model.scales) for (const [sourceWidth, sourceHeight] of [[1, 1], [1, 64], [2, 2], [8, 8], [15, 31]]) {
    const snapshot = compileUpscale({ ...request, modelId: model.id, scale, sourceWidth, sourceHeight });
    assert.equal(snapshot.parameters.width, sourceWidth * scale);
    assert.equal(snapshot.parameters.height, sourceHeight * scale);
    assert.equal(snapshot.graph.resize.inputs.width, sourceWidth * scale);
    assert.equal(snapshot.graph.resize.inputs.height, sourceHeight * scale);
    assert.equal(checkCapabilities(snapshot, discovery()).available, true);
  }
});

test("availability checks the actual restoration nodes and every upscaler artifact", () => {
  for (const model of UPSCALER_MODELS) {
    const snapshot = compileUpscale({ ...request, modelId: model.id });
    for (const artifact of model.artifacts) {
      const found = discovery();
      found.models[artifact.folder] = found.models[artifact.folder]!.filter(name => name !== artifact.filename);
      assert(checkCapabilities(snapshot, found).issues.some(issue => issue.code === "MISSING_MODEL" && issue.message.includes(artifact.filename)));
    }
    const found = discovery();
    delete found.objectInfo[model.familyId === "nomos2" ? "ImageUpscaleWithModel" : "SeedVR2Conditioning"];
    assert(checkCapabilities(snapshot, found).issues.some(issue => issue.code === "MISSING_NODE"));
  }
});

test("worker discovery finds upscale_models through both inventory API and v3 loader fallback", async t => {
  const worker = await fakeComfy(); t.after(worker.close);
  worker.state.info = discovery().objectInfo;
  const filename = getUpscaler("nomos2-hq").artifacts[0].filename;
  worker.state.responseOverride = path => path === "/models/upscale_models" ? { body: JSON.stringify([filename]) } : undefined;
  const client = new ComfyClient(worker.url);
  let found = await client.discover();
  assert.deepEqual(found.models.upscale_models, [filename]);
  assert.equal(found.modelSources.upscale_models, "models-api");
  assert.equal(checkCapabilities(compileUpscale(request), found).available, true);
  worker.state.responseOverride = undefined;
  worker.state.foldersMissing = true;
  found = await client.discover();
  assert.deepEqual(found.models.upscale_models, [filename]);
  assert.equal(found.modelSources.upscale_models, "loader-schema");
  assert.equal(checkCapabilities(compileUpscale({ ...request, modelId: "seedvr2-7b" }), found).available, true);
});
