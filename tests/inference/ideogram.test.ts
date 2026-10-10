import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCapabilities, compileGeneration, getModel, verifySnapshot } from "../../packages/inference/index.ts";
import type { ComfyDiscovery, GenerationRequest } from "../../packages/inference/index.ts";
import signatures from "./fixtures/comfy-v0.39.0-signatures.json" with { type: "json" };
import editingInfo from "./fixtures/editing-object-info.json" with { type: "json" };

const modelId = "ideogram-4-fp8";
const request = { modelId, prompt: 'Poster reading "Zażółć gęślą jaźń"\nA ceramic cup beside the lettering.', seed: 0 };

function discovery(): ComfyDiscovery {
  const model = getModel(modelId);
  const models: ComfyDiscovery["models"] = {};
  for (const artifact of model.artifacts) (models[artifact.folder] ??= []).push(artifact.filename);
  const choices: Record<string, string[]> = { unet_name: models.diffusion_models!, clip_name: models.text_encoders!, vae_name: models.vae!, sampler_name: ["euler"] };
  const snapshot = compileGeneration(request);
  const definitions = signatures.nodes as Record<string, { required: Record<string, string | string[]>; optional: Record<string, string | string[]>; outputs: string[] }>;
  const objectInfo: ComfyDiscovery["objectInfo"] = {};
  for (const { class_type } of Object.values(snapshot.graph)) {
    if (class_type === "SplitSigmas" || class_type === "DisableNoise") {
      objectInfo[class_type] = structuredClone(editingInfo[class_type]); continue;
    }
    const definition = definitions[class_type];
    const sockets = (values: Record<string, string | string[]>) => Object.fromEntries(Object.entries(values).map(([name, type]) => [name, [type === "COMBO" ? choices[name] : type]]));
    objectInfo[class_type] = { input: { required: sockets(definition.required), optional: sockets(definition.optional) }, output: definition.outputs };
  }
  return { objectInfo, models, modelSources: {} };
}

test("Ideogram uses independent conditional and image-only unconditional models with its native scheduler", () => {
  const snapshot = compileGeneration(request);
  const graph = snapshot.graph;
  assert.equal(graph.model.inputs.unet_name, "ideogram4_fp8_scaled.safetensors");
  assert.equal(graph.model_negative.inputs.unet_name, "ideogram4_unconditional_fp8_scaled.safetensors");
  assert.equal(graph.model.inputs.weight_dtype, "default");
  assert.equal(graph.model_negative.inputs.weight_dtype, "default");
  assert.equal(graph.clip.inputs.type, "ideogram4");
  assert.equal(graph.vae.inputs.vae_name, "flux2-vae.safetensors");
  assert.deepEqual(graph.guider.inputs, { model: ["model", 0], model_negative: ["model_negative", 0], positive: ["positive", 0], cfg: 7 });
  assert.equal("negative" in graph, false, "zeroed text would run the wrong unconditional model path");
  assert.deepEqual(graph.polish.inputs, { model: ["model", 0], model_negative: ["model_negative", 0], positive: ["positive", 0], cfg: 3 });
  assert.deepEqual(graph.polish_schedule.inputs, { sigmas: ["schedule", 0], step: 18 });
  assert.deepEqual(graph.schedule.inputs, { steps: 20, width: 1024, height: 1024, mu: 0, std: 1.75 });
  assert.deepEqual(graph.latent.inputs, { width: 1024, height: 1024, batch_size: 1 });
  assert.equal(graph.noise.inputs.noise_seed, 0);
  assert.equal(graph.sampler.inputs.sampler_name, "euler");
  assert.deepEqual(graph.sample.inputs, { noise: ["noise", 0], guider: ["guider", 0], sampler: ["sampler", 0], sigmas: ["polish_schedule", 0], latent_image: ["latent", 0] });
  assert.deepEqual(graph.output.inputs.images, ["decode", 0]);
  verifySnapshot(snapshot);
});

test("Ideogram preserves plain prompts in a minimal ordered caption and immutable snapshot", () => {
  const snapshot = compileGeneration(request);
  const caption = JSON.parse(String(snapshot.graph.positive.inputs.text));
  assert.deepEqual(caption, { high_level_description: request.prompt, compositional_deconstruction: { background: "", elements: [] } });
  assert.deepEqual(Object.keys(caption.compositional_deconstruction), ["background", "elements"]);
  assert.equal(snapshot.parameters.prompt, request.prompt);
  assert.equal(compileGeneration(request).hash, snapshot.hash);
  const manifest = structuredClone(getModel(modelId));
  manifest.artifacts.find(artifact => artifact.role === "diffusion-unconditional")!.filename = "alternate-unconditional.safetensors";
  const different = compileGeneration(request, manifest);
  assert.notEqual(different.hash, snapshot.hash);
  manifest.artifacts[0].filename = "later-change.safetensors";
  assert.equal(different.model.artifacts[0].filename, snapshot.model.artifacts[0].filename);
  verifySnapshot(different);
});

test("Ideogram applies supported size, steps and guidance edits without raising low guidance", () => {
  for (const cfg of [0, 1, 2, 3, 7]) {
    const { graph } = compileGeneration({ ...request, cfg, steps: 28, width: 1536, height: 1024 });
    assert.equal(graph.guider.inputs.cfg, cfg);
    assert.equal(graph.polish.inputs.cfg, Math.min(cfg, 3));
    assert.deepEqual(graph.schedule.inputs, { steps: 28, width: 1536, height: 1024, mu: 0, std: 1.75 });
    assert.deepEqual(graph.latent.inputs, { width: 1536, height: 1024, batch_size: 1 });
  }
  assert.doesNotThrow(() => compileGeneration({ ...request, width: 2048, height: 2048 }));
  for (const change of [
    { width: 1025 }, { width: 2304 }, { width: 2048, height: 256 },
    { negativePrompt: "blur" }, { scheduler: "normal" }, { clipSkip: 2 }, { denoise: 0.5 },
    { operation: "text-to-image", images: [{ filename: "a.png", subfolder: "", type: "input" }] },
    { operation: "reference" }, { operation: "image-to-image" },
  ] satisfies Partial<GenerationRequest>[]) assert.throws(() => compileGeneration({ ...request, ...change }), { code: "INVALID_INPUT" });
});

test("Ideogram discovery requires both diffusion files, native nodes and the correct encoder enum", () => {
  const snapshot = compileGeneration(request);
  assert.deepEqual(checkCapabilities(snapshot, discovery()), { available: true, issues: [], integrity: "filenames-only" });
  const missingFile = discovery();
  missingFile.models.diffusion_models = ["ideogram4_fp8_scaled.safetensors"];
  assert(checkCapabilities(snapshot, missingFile).issues.some(issue => issue.code === "MISSING_MODEL" && issue.message.includes("unconditional")));
  for (const name of ["Ideogram4Scheduler", "DualModelGuider", "SplitSigmas", "DisableNoise"]) {
    const missingNode = discovery(); delete missingNode.objectInfo[name];
    assert(checkCapabilities(snapshot, missingNode).issues.some(issue => issue.code === "MISSING_NODE" && issue.message.includes(name)));
  }
  const wrongEncoder = discovery(); wrongEncoder.objectInfo.CLIPLoader.input!.required!.type = [["flux2"]];
  assert(checkCapabilities(snapshot, wrongEncoder).issues.some(issue => issue.code === "INVALID_NODE_INPUT"));
  const wrongLink = discovery(); wrongLink.objectInfo.DualModelGuider.input!.optional!.model_negative = ["CONDITIONING"];
  assert(checkCapabilities(snapshot, wrongLink).issues.some(issue => issue.code === "INVALID_LINK"));
});
