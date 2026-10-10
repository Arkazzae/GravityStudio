import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCapabilities, compileGeneration, FAMILY_RECIPES, getModel, verifySnapshot } from "../../packages/inference/index.ts";
import type { ComfyDiscovery, InputImage } from "../../packages/inference/index.ts";
import qwenObjectInfo from "./fixtures/qwen-image-2.1-object-info.json" with { type: "json" };
import backgroundObjectInfo from "./fixtures/background-object-info.json" with { type: "json" };
import { sdxlObjectInfo } from "./fake-comfy.ts";

const modelId = "qwen-image-2.1";
const reference = (index: number): InputImage => ({ filename: `reference-${index}.png`, subfolder: "grav/request", type: "input" });
const references = Array.from({ length: 10 }, (_, index) => reference(index));
const request = { modelId, prompt: "Keep the face from <image1> and use the clothes from <image2>", seed: 1234 };

function discovery(): ComfyDiscovery {
  const model = getModel(modelId);
  const filename = (role: string) => model.artifacts.find(artifact => artifact.role === role)!.filename;
  return {
    objectInfo: {
      ...structuredClone(sdxlObjectInfo), ...structuredClone(qwenObjectInfo), JoinImageWithAlpha: structuredClone(backgroundObjectInfo.JoinImageWithAlpha),
      UNETLoader: { input: { required: { unet_name: [[filename("diffusion")]], weight_dtype: [["default"]] } }, output: ["MODEL"] },
      CLIPLoader: { input: { required: { clip_name: [[filename("text-encoder")]], type: [["qwen_image"]] }, optional: { device: [["default", "cpu"]] } }, output: ["CLIP"] },
      VAELoader: { input: { required: { vae_name: [[filename("vae")]] } }, output: ["VAE"] },
    },
    models: Object.fromEntries(model.artifacts.map(artifact => [artifact.folder, [artifact.filename]])), modelSources: {},
  };
}

test("Qwen text-to-image uses its unified encoder, lossless automatic cache and PNG output", () => {
  const snapshot = compileGeneration({ ...request, negativePrompt: "blurry lettering", cfg: 2, width: 2752, height: 1536 });
  assert.equal(snapshot.model.license, "Qwen Research License (non-commercial)");
  assert(snapshot.model.artifacts.every(artifact => artifact.filename.includes("bf16") && /^[a-f0-9]{64}$/.test(artifact.sha256!) && artifact.source?.includes("/cb504a4090723e43f17ad01cec0359490e2de613/")));
  assert.equal(snapshot.graph.clip.inputs.type, "qwen_image");
  assert.equal(snapshot.graph.conditioning.class_type, "TextEncodeQwenImage21");
  assert.equal(snapshot.graph.conditioning.inputs.prompt, request.prompt);
  assert.equal(snapshot.graph.conditioning.inputs.negative_prompt, "blurry lettering");
  assert.deepEqual(snapshot.graph.sample.inputs.positive, ["conditioning", 0]);
  assert.deepEqual(snapshot.graph.sample.inputs.negative, ["conditioning", 1]);
  assert.deepEqual(snapshot.graph.sample.inputs.model, ["cache", 0]);
  assert.deepEqual(snapshot.graph.cache.inputs, { model: ["model", 0], device: "auto", dtype: "default" });
  assert.deepEqual(snapshot.graph.latent.inputs, { width: 2752, height: 1536, batch_size: 1 });
  assert.equal(snapshot.graph.sample.inputs.steps, 25);
  assert.equal(snapshot.graph.sample.inputs.scheduler, "simple");
  assert.equal(snapshot.graph.output.class_type, "SaveImage");
  assert.deepEqual(snapshot.graph.output.inputs.images, ["decode", 0]);
  assert.equal("vae" in snapshot.graph.conditioning.inputs, false);
  verifySnapshot(snapshot);
});

test("Qwen references retain slot order, VAE conditioning and the requested output canvas", () => {
  const snapshot = compileGeneration({ ...request, operation: "reference", images: references, width: 1536, height: 1024 });
  assert.deepEqual(snapshot.graph.conditioning.inputs.vae, ["vae", 0]);
  for (const index of references.keys()) {
    const link = snapshot.graph.conditioning.inputs[`images.image_${index + 1}`];
    assert.deepEqual(link, [`reference_${index}_rgba`, 0]);
    assert.deepEqual(snapshot.graph[`reference_${index}_rgba`].inputs.alpha, [`reference_${index}`, 1]);
    assert.equal(snapshot.graph[`reference_${index}`].inputs.image, `grav/request/reference-${index}.png`);
  }
  assert.equal(snapshot.graph.conditioning.inputs.resolution, 992);
  assert.deepEqual(snapshot.graph.sample.inputs.latent_image, ["latent", 0]);
  assert.deepEqual(snapshot.graph.latent.inputs, { width: 1568, height: 1056, batch_size: 1 });
  assert.equal(snapshot.parameters.denoise, 1);
  assert.equal(snapshot.graph.sample.inputs.denoise, 1);
  assert.equal(snapshot.graph.sample.inputs.cfg, 1);
  assert.equal(snapshot.inputs.length, 10);
});

test("Qwen reference edits avoid reported sampling grids and save exactly the requested dimensions", () => {
  for (const [width, height, sampleWidth, sampleHeight] of [[1024, 1024, 1056, 1056], [1536, 1024, 1568, 1056], [768, 1024, 768, 1024]]) {
    const snapshot = compileGeneration({ ...request, operation: "reference", images: references.slice(0, 1), width, height });
    assert.equal(snapshot.recipe.revision, "3");
    assert.deepEqual([snapshot.parameters.width, snapshot.parameters.height], [width, height]);
    assert.deepEqual(snapshot.graph.latent.inputs, { width: sampleWidth, height: sampleHeight, batch_size: 1 });
    assert.equal(snapshot.graph.conditioning.inputs.resolution, 992);
    if (sampleWidth !== width) {
      assert.equal(snapshot.graph.output_resize.class_type, "ImageScale");
      assert.deepEqual(snapshot.graph.output_resize.inputs, { image: ["decode", 0], upscale_method: "bicubic", width, height, crop: "disabled" });
      assert.deepEqual(snapshot.graph.output.inputs.images, ["output_resize", 0]);
    } else {
      assert.equal("output_resize" in snapshot.graph, false);
      assert.deepEqual(snapshot.graph.output.inputs.images, ["decode", 0]);
    }
    assert.equal(checkCapabilities(snapshot, discovery()).available, true);
    verifySnapshot(snapshot);

    const textOnly = compileGeneration({ ...request, width, height });
    assert.deepEqual(textOnly.graph.latent.inputs, { width, height, batch_size: 1 });
    assert.equal(textOnly.graph.conditioning.inputs.resolution, 1024);
    assert.equal("output_resize" in textOnly.graph, false);
    assert.deepEqual(textOnly.graph.output.inputs.images, ["decode", 0]);
  }
});

test("every affected Qwen reference canvas stays within the pixel budget after adjustment", () => {
  const { min, max, multiple, maxPixels } = FAMILY_RECIPES[modelId].dimensions;
  let affected = 0;
  for (let width = min; width <= max; width += multiple) {
    for (let height = min; height <= max; height += multiple) {
      if (width * height > maxPixels || (width / 16) * (height / 16) % 2048 !== 0) continue;
      affected++;
      const snapshot = compileGeneration({ ...request, operation: "reference", images: references.slice(0, 1), width, height });
      const sampleWidth = Number(snapshot.graph.latent.inputs.width), sampleHeight = Number(snapshot.graph.latent.inputs.height);
      assert(sampleWidth * sampleHeight <= maxPixels, `${width}x${height} exceeds the sampling budget`);
      assert.notEqual((sampleWidth / 16) * (sampleHeight / 16) % 2048, 0, `${width}x${height} still uses an affected grid`);
      assert.equal(snapshot.graph.output_resize.inputs.width, width);
      assert.equal(snapshot.graph.output_resize.inputs.height, height);
    }
  }
  assert(affected > 0);
});

test("Qwen enforces its 32-pixel grid, native pixel budget and ten-reference contract", () => {
  for (const [width, height] of [[2048, 2048], [2400, 1792], [2528, 1696], [2752, 1536]]) {
    assert.doesNotThrow(() => compileGeneration({ ...request, width, height }));
  }
  assert.throws(() => compileGeneration({ ...request, width: 1040 }), /multiples of 32/);
  assert.throws(() => compileGeneration({ ...request, width: 4096, height: 4096 }), /at most/);
  assert.throws(() => compileGeneration({ ...request, operation: "reference", images: [...references, reference(10)] }), /Too many images/);
  assert.throws(() => compileGeneration({ ...request, operation: "reference", images: references, denoise: 0.5 }), /image-to-image only/);
  assert.throws(() => compileGeneration({ ...request, operation: "image-to-image", images: references.slice(0, 1) }), /does not support/);
  assert.throws(() => compileGeneration({ ...request, clipSkip: 2 }), /CLIP skip/);
  assert.throws(() => compileGeneration({ ...request, scheduler: "native" }), /ComfyUI scheduler/);
});

test("worker capability checks expand the actual Qwen V3 reference schema for zero, one and ten images", () => {
  const found = discovery();
  const before = structuredClone(found);
  for (const images of [[], references.slice(0, 1), references]) {
    const snapshot = compileGeneration({ ...request, operation: images.length ? "reference" : "text-to-image", images });
    assert.deepEqual(checkCapabilities(snapshot, found), { available: true, issues: [], integrity: "filenames-only" });
  }
  assert.deepEqual(found, before);
});

test("Qwen discovery rejects older workers, unsupported cache controls and mismatched reference types", () => {
  const snapshot = compileGeneration({ ...request, operation: "reference", images: references });
  const missing = discovery();
  delete missing.objectInfo.TextEncodeQwenImage21;
  assert(checkCapabilities(snapshot, missing).issues.some(issue => issue.code === "MISSING_NODE"));

  const cache = discovery();
  cache.objectInfo.QwenImage21Cache.input!.required!.dtype = ["COMBO", { options: ["int8", "int4"] }];
  assert(checkCapabilities(snapshot, cache).issues.some(issue => issue.code === "INVALID_NODE_INPUT" && issue.message.includes("dtype")));

  const wrongType = discovery();
  const wrapper = wrongType.objectInfo.TextEncodeQwenImage21.input!.required!.images[1] as typeof qwenObjectInfo.TextEncodeQwenImage21.input.required.images[1];
  assert(wrapper && typeof wrapper === "object" && "template" in wrapper);
  wrapper.template.input.required.image = ["MASK", {}];
  assert.equal(checkCapabilities(snapshot, wrongType).issues.filter(issue => issue.code === "INVALID_LINK").length, 10);
});

test("autogrow discovery respects minimum slots, declared names and malformed templates", () => {
  const editing = compileGeneration({ ...request, operation: "reference", images: references });
  const textOnly = compileGeneration(request);
  const required = discovery();
  const wrapper = required.objectInfo.TextEncodeQwenImage21.input!.required!.images[1] as { template: { min: number; names: string[] } };
  wrapper.template.min = 1;
  assert(checkCapabilities(textOnly, required).issues.some(issue => issue.message.includes("missing required input images.image_1")));
  assert.equal(checkCapabilities(editing, required).available, true);
  wrapper.template.names = wrapper.template.names.slice(0, 9);
  assert(checkCapabilities(editing, required).issues.some(issue => issue.message.includes("images.image_10 is unavailable")));
  wrapper.template.min = -1;
  assert(checkCapabilities(editing, required).issues.some(issue => issue.message.includes("unsupported schema")));

  const ambiguous = discovery();
  const multiple = ambiguous.objectInfo.TextEncodeQwenImage21.input!.required!.images[1] as { template: { input: { required: Record<string, unknown[]> } } };
  multiple.template.input.required.mask = ["MASK", {}];
  assert(checkCapabilities(editing, ambiguous).issues.some(issue => issue.message.includes("unsupported schema")));
});
