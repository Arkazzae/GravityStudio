import { isRelativeFile } from "./catalog.ts";
import { snapshotHash, validateInputImage } from "./compiler.ts";
import { InferenceError } from "./types.ts";
import type { GraphLink, ArtifactRole, ModelArtifact, UpscaleParameters, UpscaleRequest, UpscaleSnapshot, UpscalerManifest, WorkflowGraph } from "./types.ts";

const GiB = 1024 ** 3;
const seedSource = "https://huggingface.co/Comfy-Org/SeedVR2/resolve/df48879708206a403d2a61acd55578c2e80fd233";
const seedVae: ModelArtifact = {
  role: "vae", folder: "vae", filename: "seedvr2_ema_vae_fp16.safetensors",
  source: `${seedSource}/vae/seedvr2_ema_vae_fp16.safetensors`,
  sha256: "20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1",
};

/** Core ComfyUI v0.39.0 recipes: no custom nodes or separate model containers. */
export const UPSCALER_MODELS: readonly UpscalerManifest[] = [
  {
    id: "nomos2-hq", name: "Nomos2 HQ", familyId: "nomos2", revision: "1",
    description: "Restores detail in clean images with a 4× DRCT model; 2× output is reduced after restoration. Preserves source transparency.",
    license: "CC-BY-4.0", licenseUrl: "https://huggingface.co/Phips/4xNomos2_hq_drct-l",
    scales: [2, 4], maxOutputDimension: 4096,
    // Estimates retain headroom over the previous 2048² input qualification,
    // including Nomos's 8192² intermediate when producing a 4096² 2× result.
    memory: { ramBytes: 6 * GiB, vramBytes: 15 * GiB },
    artifacts: [{
      role: "upscale", folder: "upscale_models", filename: "4xNomos2_hq_drct-l.safetensors",
      source: "https://huggingface.co/Phips/4xNomos2_hq_drct-l/resolve/b2a537e13edc4c1108506df04ee0807ffc927d74/4xNomos2_hq_drct-l.safetensors",
      sha256: "1a10632101bb2aca6151301dd811921f1c438ff55159fd579fb576c143477797",
    }],
  },
  {
    id: "seedvr2-3b", name: "SeedVR2 3B", familyId: "seedvr2", revision: "1",
    description: "Restores image detail using the native SeedVR2 3B diffusion upscaler. Preserves source transparency.",
    license: "Apache-2.0", licenseUrl: "https://huggingface.co/Comfy-Org/SeedVR2",
    scales: [2, 4], maxOutputDimension: 4096,
    memory: { ramBytes: 12 * GiB, vramBytes: 21 * GiB },
    artifacts: [{
      role: "diffusion", folder: "diffusion_models", filename: "seedvr2_3b_fp16.safetensors",
      source: `${seedSource}/diffusion_models/seedvr2_3b_fp16.safetensors`,
      sha256: "98669fd2c06df5eca88baf68cd5c478775c8e61fc110e598c52b350145ea2660",
    }, { ...seedVae }],
  },
  {
    id: "seedvr2-7b", name: "SeedVR2 7B", familyId: "seedvr2", revision: "1",
    description: "Restores image detail using the native SeedVR2 7B diffusion upscaler, with higher memory requirements. Preserves source transparency.",
    license: "Apache-2.0", licenseUrl: "https://huggingface.co/Comfy-Org/SeedVR2",
    scales: [2, 4], maxOutputDimension: 4096,
    memory: { ramBytes: 24 * GiB, vramBytes: 29 * GiB },
    artifacts: [{
      role: "diffusion", folder: "diffusion_models", filename: "seedvr2_7b_fp16.safetensors",
      source: `${seedSource}/diffusion_models/seedvr2_7b_fp16.safetensors`,
      sha256: "2742ca6fee63bc5cc1773f426dd4b07b78cad27f51c9ea5cd42b035e6b592252",
    }, { ...seedVae }],
  },
];

export function validateUpscaler(model: UpscalerManifest): void {
  const check = (condition: unknown, message: string): void => { if (!condition) throw new InferenceError("INVALID_MODEL", message); };
  check(model && typeof model === "object" && !Array.isArray(model), "An upscaler manifest must be an object.");
  check(Object.keys(model).every(key => ["id", "name", "familyId", "revision", "artifacts", "description", "license", "licenseUrl", "scales", "maxOutputDimension", "memory"].includes(key)), "Unknown upscaler manifest field.");
  check(typeof model.id === "string" && /^[a-z0-9][a-z0-9._-]{0,95}$/.test(model.id), "Set a valid upscaler ID.");
  check(typeof model.name === "string" && model.name.trim() && model.name.length <= 160, "Set an upscaler name of at most 160 characters.");
  check(typeof model.revision === "string" && /^[a-zA-Z0-9._-]{1,96}$/.test(model.revision), "Set a stable upscaler revision.");
  check(model.familyId === "nomos2" || model.familyId === "seedvr2", "This upscaler architecture has no recipe.");
  check(typeof model.description === "string" && model.description.length <= 4000, "Set a bounded upscaler description.");
  check(model.license === undefined || typeof model.license === "string" && model.license.length <= 4000, "Set a bounded upscaler license.");
  check(Array.isArray(model.scales) && model.scales.length > 0 && new Set(model.scales).size === model.scales.length && model.scales.every(scale => scale === 2 || scale === 4), "Upscalers support 2× or 4× output.");
  check(Number.isInteger(model.maxOutputDimension) && model.maxOutputDimension >= 2 && model.maxOutputDimension <= 4096, "Upscaler output cannot exceed 4096 pixels per side.");
  check(model.memory && typeof model.memory === "object" && Object.keys(model.memory).every(key => key === "ramBytes" || key === "vramBytes") && [model.memory.ramBytes, model.memory.vramBytes].every(value => Number.isSafeInteger(value) && value > 0), "Set positive upscaler memory reservations.");
  const https = (value: unknown): boolean => {
    if (typeof value !== "string" || value.length > 2048) return false;
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
  };
  check(model.licenseUrl === undefined || https(model.licenseUrl), "Set a valid HTTPS license URL without credentials.");
  const folders = model.familyId === "nomos2" ? { upscale: "upscale_models" } : { diffusion: "diffusion_models", vae: "vae" };
  check(Array.isArray(model.artifacts) && model.artifacts.length === Object.keys(folders).length, "List exactly the artifacts required by the upscaler.");
  const seen = new Set<string>();
  for (const artifact of model.artifacts) {
    check(artifact && typeof artifact === "object" && !Array.isArray(artifact), "Invalid upscaler artifact.");
    check(Object.keys(artifact).every(key => ["role", "folder", "filename", "sha256", "source"].includes(key)), "Unknown upscaler artifact field.");
    check(Object.hasOwn(folders, artifact.role) && artifact.folder === folders[artifact.role as keyof typeof folders] && !seen.has(artifact.role), "Each upscaler artifact must use its matching role and model folder.");
    seen.add(artifact.role);
    check(isRelativeFile(artifact.filename), "Upscaler files must be relative to their model folder.");
    check(artifact.sha256 === undefined || typeof artifact.sha256 === "string" && /^[a-f0-9]{64}$/.test(artifact.sha256), "Set a valid upscaler SHA-256.");
    check(artifact.source === undefined || https(artifact.source), "Set a valid HTTPS artifact URL without credentials.");
  }
}

export function getUpscaler(id: string, models: readonly UpscalerManifest[] = UPSCALER_MODELS): UpscalerManifest {
  const model = models.find(item => item.id === id);
  if (!model) throw new InferenceError("MODEL_NOT_FOUND", "The selected upscaler is not in the catalog.");
  validateUpscaler(model);
  return structuredClone(model);
}

function upscaleGraph(model: UpscalerManifest, p: UpscaleParameters, image: string): WorkflowGraph {
  const file = (role: ArtifactRole) => model.artifacts.find(artifact => artifact.role === role)!.filename;
  const graph: WorkflowGraph = { input_image: { class_type: "LoadImage", inputs: { image } } };
  if (model.familyId === "nomos2") {
    graph.upscale_model = { class_type: "UpscaleModelLoader", inputs: { model_name: file("upscale") } };
    graph.upscale = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["upscale_model", 0], image: ["input_image", 0] } };
    graph.resize = { class_type: "ImageScale", inputs: { image: ["upscale", 0], upscale_method: "lanczos", width: p.width, height: p.height, crop: "disabled" } };
  } else {
    // Official native image workflow, using converted weights with embedded
    // positive/negative conditioning: Comfy-Org/workflow_templates,
    // templates/utility_seedvr2_3b_int8_upscale_image.json (FP16 also supported).
    graph.resize = { class_type: "ImageScale", inputs: { image: ["input_image", 0], upscale_method: "lanczos", width: p.width, height: p.height, crop: "disabled" } };
    graph.preprocess = { class_type: "SeedVR2Preprocess", inputs: { resized_images: ["resize", 0] } };
    graph.model = { class_type: "UNETLoader", inputs: { unet_name: file("diffusion"), weight_dtype: "default" } };
    graph.vae = { class_type: "VAELoader", inputs: { vae_name: file("vae") } };
    const tiled = { tile_size: 512, overlap: 128, temporal_size: 4096, temporal_overlap: 8 };
    graph.encode = { class_type: "VAEEncodeTiled", inputs: { pixels: ["preprocess", 0], vae: ["vae", 0], ...tiled } };
    graph.conditioning = { class_type: "SeedVR2Conditioning", inputs: { model: ["model", 0], vae_conditioning: ["encode", 0] } };
    graph.sample = { class_type: "KSampler", inputs: { model: ["model", 0], positive: ["conditioning", 0], negative: ["conditioning", 1], latent_image: ["encode", 0], seed: p.seed, steps: 1, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } };
    graph.decode = { class_type: "VAEDecodeTiled", inputs: { samples: ["sample", 0], vae: ["vae", 0], ...tiled } };
    graph.postprocess = { class_type: "SeedVR2PostProcessing", inputs: { images: ["decode", 0], original_resized_images: ["resize", 0], color_correction_method: "lab" } };
  }
  // LoadImage's mask is inverted alpha, exactly what JoinImageWithAlpha needs.
  // Core resizes it bilinearly to the final canvas, preserving opacity for RGB
  // sources and soft edges for RGBA independently of restoration/color changes.
  graph.alpha = { class_type: "JoinImageWithAlpha", inputs: { image: [model.familyId === "nomos2" ? "resize" : "postprocess", 0], alpha: ["input_image", 1] } };
  graph.output = { class_type: "SaveImage", inputs: { images: ["alpha", 0], filename_prefix: "grav-upscale" } };
  return graph;
}

/** Append the same native restoration recipe to an existing image tensor. */
export function appendUltraGraph(graph: WorkflowGraph, model: UpscalerManifest, parameters: { width: number; height: number; seed: number }): void {
  validateUpscaler(model);
  if (model.id !== "seedvr2-7b" || model.familyId !== "seedvr2") throw new InferenceError("INVALID_MODEL", "Ultra requires the pinned SeedVR2 7B upscaler.");
  const source = graph.output.inputs.images as GraphLink;
  graph.ultra_source = { class_type: "SplitImageWithAlpha", inputs: { image: source } };
  const restoration = upscaleGraph(model, { ...parameters, scale: 2, sourceWidth: 1, sourceHeight: 1 }, "unused.png");
  delete restoration.input_image;
  const rename = ([node, output]: GraphLink): GraphLink => [node === "input_image" ? "ultra_source" : `ultra_${node}`, output];
  for (const [id, node] of Object.entries(restoration)) {
    graph[id === "output" ? "output" : `ultra_${id}`] = {
      ...node, inputs: Object.fromEntries(Object.entries(node.inputs).map(([key, value]) => [key, Array.isArray(value) ? rename(value) : value])),
    };
  }
  graph.output.inputs.filename_prefix = "grav-ultra";
}

export function compileUpscale(request: UpscaleRequest, model?: UpscalerManifest): UpscaleSnapshot {
  const check = (condition: unknown, message: string): void => { if (!condition) throw new InferenceError("INVALID_INPUT", message); };
  check(request && typeof request === "object" && !Array.isArray(request) && Object.keys(request).every(key => ["modelId", "scale", "sourceWidth", "sourceHeight", "image", "seed"].includes(key)), "Unknown upscale parameter.");
  check(Object.values(request).every(value => value !== null), "Upscale parameters cannot be null.");
  model ??= getUpscaler(request.modelId);
  validateUpscaler(model);
  check(request.modelId === model.id, "The request and upscaler manifest do not match.");
  check(model.scales.includes(request.scale), "Choose a supported upscale factor: 2× or 4×.");
  // Spandrel safely pads tiny DRCT inputs with reflection plus replication.
  // Native SeedVR2 zero-pads the resized canvas to 16; even a 1px source
  // becomes at least 2px, satisfying its preprocessing minimum.
  for (const side of [request.sourceWidth, request.sourceHeight]) check(Number.isInteger(side) && side >= 1 && side <= 2048, "Source dimensions must be integers from 1 to 2048 pixels.");
  const width = request.sourceWidth * request.scale, height = request.sourceHeight * request.scale;
  check(Math.max(width, height) <= model.maxOutputDimension, `The requested output exceeds ${model.maxOutputDimension} pixels per side. Choose a smaller scale or source image.`);
  const seed = request.seed ?? 42;
  check(Number.isSafeInteger(seed) && seed >= 0, "Seed must be a nonnegative safe integer.");
  validateInputImage(request.image);
  const image = structuredClone(request.image);
  const parameters: UpscaleParameters = { scale: request.scale, sourceWidth: request.sourceWidth, sourceHeight: request.sourceHeight, width, height, seed };
  const content: Omit<UpscaleSnapshot, "hash"> = {
    schemaVersion: 1, recipe: { familyId: model.familyId, revision: "1", operation: "upscale" },
    model: structuredClone(model), parameters, inputs: [image],
    graph: upscaleGraph(model, parameters, image.subfolder ? `${image.subfolder}/${image.filename}` : image.filename),
    outputs: [{ node: "output", field: "images" }],
  };
  return { ...content, hash: snapshotHash(content) };
}
