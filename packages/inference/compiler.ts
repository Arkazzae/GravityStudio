import { createHash, randomInt } from "node:crypto";
import { FAMILY_RECIPES, getModel, isRelativeFile, validateModel } from "./catalog.ts";
import { InferenceError } from "./types.ts";
import type { ArtifactRole, ExecutionSnapshot, GenerationRequest, GraphLink, InputImage, ModelManifest, ResolvedParameters, WorkflowGraph } from "./types.ts";

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function snapshotHash(snapshot: Omit<ExecutionSnapshot, "hash">): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

export function verifySnapshot(snapshot: ExecutionSnapshot): void {
  const { hash, ...content } = snapshot;
  if (snapshot.schemaVersion !== 1 || typeof hash !== "string" || snapshotHash(content) !== hash) {
    throw new InferenceError("INVALID_SNAPSHOT", "The execution snapshot changed after compilation.");
  }
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InferenceError("INVALID_INPUT", message);
}

const requestKeys = new Set(["modelId", "operation", "prompt", "negativePrompt", "width", "height", "seed", "steps", "cfg", "sampler", "scheduler", "clipSkip", "denoise", "images"]);

export function validateInputImage(image: InputImage): void {
  check(image && typeof image === "object" && Object.keys(image).every(key => ["filename", "subfolder", "type"].includes(key)), "Invalid input image reference.");
  check(image.type === "input" && isRelativeFile(image.filename) && !image.filename.includes("/"), "Choose an uploaded input image.");
  check(image.subfolder === "" || isRelativeFile(image.subfolder), "Invalid input image folder.");
}

function imageName(image: InputImage): string {
  return image.subfolder ? `${image.subfolder}/${image.filename}` : image.filename;
}

function parametersFor(request: GenerationRequest, model: ModelManifest): ResolvedParameters {
  const family = FAMILY_RECIPES[model.familyId];
  const defaults = { ...family.defaults, ...model.defaults };
  check(typeof request.prompt === "string" && request.prompt.trim().length > 0 && request.prompt.length <= 16_000, "Write a prompt of 1–16,000 characters.");
  const p: ResolvedParameters = {
    ...defaults,
    prompt: request.prompt,
    negativePrompt: request.negativePrompt ?? defaults.negativePrompt,
    width: request.width ?? defaults.width, height: request.height ?? defaults.height,
    seed: request.seed ?? randomInt(0, 2 ** 32), steps: request.steps ?? defaults.steps,
    cfg: request.cfg ?? defaults.cfg, sampler: request.sampler ?? defaults.sampler,
    scheduler: request.scheduler ?? defaults.scheduler, clipSkip: request.clipSkip ?? defaults.clipSkip,
    denoise: request.denoise ?? (request.operation === "image-to-image" ? 0.65 : 1),
  };
  const { min, max, multiple, maxPixels } = family.dimensions;
  for (const value of [p.width, p.height]) check(Number.isInteger(value) && value >= min && value <= max && value % multiple === 0, `Dimensions must be multiples of ${multiple}, from ${min} to ${max}.`);
  check(p.width * p.height <= maxPixels, `This recipe supports at most ${maxPixels.toLocaleString("en")} pixels.`);
  check(Number.isSafeInteger(p.seed) && p.seed >= 0, "Seed must be a nonnegative safe integer.");
  check(Number.isInteger(p.steps) && p.steps >= 1 && p.steps <= 100, "Steps must be an integer from 1 to 100.");
  check(typeof p.cfg === "number" && Number.isFinite(p.cfg) && p.cfg >= 0 && p.cfg <= 30, "Guidance must be between 0 and 30.");
  check(typeof p.denoise === "number" && Number.isFinite(p.denoise) && p.denoise > 0 && p.denoise <= 1, "Denoise must be greater than 0 and at most 1.");
  check(request.operation === "image-to-image" || p.denoise === 1, "Denoise strength is available for image-to-image only.");
  check(typeof p.negativePrompt === "string" && p.negativePrompt.length <= 16_000, "Negative prompt exceeds 16,000 characters.");
  check(Number.isInteger(p.clipSkip) && p.clipSkip >= 1 && p.clipSkip <= 12, "CLIP skip must be an integer from 1 to 12.");
  check(model.familyId === "sdxl" || p.clipSkip === 1, "This family does not support CLIP skip.");
  for (const value of [p.sampler, p.scheduler]) check(typeof value === "string" && /^[a-z0-9][a-z0-9_+.-]{0,95}$/i.test(value), "Invalid sampling method.");
  if (model.familyId.startsWith("flux-2-klein")) {
    check(p.scheduler === "native", "FLUX.2 Klein uses its native resolution-aware scheduler.");
    check(!p.negativePrompt, "This FLUX.2 Klein recipe does not accept a negative prompt.");
  } else check(p.scheduler !== "native", "Select a ComfyUI scheduler for this family.");
  return p;
}

function artifact(model: ModelManifest, role: ArtifactRole): string {
  return model.artifacts.find(item => item.role === role)!.filename;
}

function sampledGraph(model: ModelManifest, p: ResolvedParameters, images: InputImage[]): WorkflowGraph {
  const graph: WorkflowGraph = {};
  let modelLink: GraphLink, clipLink: GraphLink, vaeLink: GraphLink;
  if (model.familyId === "sdxl") {
    graph.checkpoint = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: artifact(model, "checkpoint") } };
    graph.clip = { class_type: "CLIPSetLastLayer", inputs: { clip: ["checkpoint", 1], stop_at_clip_layer: -p.clipSkip } };
    modelLink = ["checkpoint", 0]; clipLink = ["clip", 0]; vaeLink = ["checkpoint", 2];
  } else {
    graph.model = { class_type: "UNETLoader", inputs: { unet_name: artifact(model, "diffusion"), weight_dtype: "default" } };
    graph.clip = { class_type: "CLIPLoader", inputs: { clip_name: artifact(model, "text-encoder"), type: "krea2", device: "default" } };
    graph.vae = { class_type: "VAELoader", inputs: { vae_name: artifact(model, "vae") } };
    modelLink = ["model", 0]; clipLink = ["clip", 0]; vaeLink = ["vae", 0];
  }
  graph.positive = { class_type: "CLIPTextEncode", inputs: { clip: clipLink, text: p.prompt } };
  graph.negative = { class_type: "CLIPTextEncode", inputs: { clip: clipLink, text: p.negativePrompt } };
  if (images.length) {
    graph.input_image = { class_type: "LoadImage", inputs: { image: imageName(images[0]) } };
    graph.resize = { class_type: "ImageScale", inputs: { image: ["input_image", 0], upscale_method: "lanczos", width: p.width, height: p.height, crop: "center" } };
    graph.latent = { class_type: "VAEEncode", inputs: { pixels: ["resize", 0], vae: vaeLink } };
  } else graph.latent = { class_type: "EmptyLatentImage", inputs: { width: p.width, height: p.height, batch_size: 1 } };
  graph.sample = { class_type: "KSampler", inputs: { model: modelLink, positive: ["positive", 0], negative: ["negative", 0], latent_image: ["latent", 0], seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: p.sampler, scheduler: p.scheduler, denoise: p.denoise } };
  graph.decode = { class_type: "VAEDecode", inputs: { samples: ["sample", 0], vae: vaeLink } };
  graph.output = { class_type: "SaveImage", inputs: { images: ["decode", 0], filename_prefix: "grav" } };
  return graph;
}

function kleinGraph(model: ModelManifest, p: ResolvedParameters, images: InputImage[]): WorkflowGraph {
  const graph: WorkflowGraph = {
    model: { class_type: "UNETLoader", inputs: { unet_name: artifact(model, "diffusion"), weight_dtype: "default" } },
    clip: { class_type: "CLIPLoader", inputs: { clip_name: artifact(model, "text-encoder"), type: "flux2", device: "default" } },
    vae: { class_type: "VAELoader", inputs: { vae_name: artifact(model, "vae") } },
    positive: { class_type: "CLIPTextEncode", inputs: { clip: ["clip", 0], text: p.prompt } },
    negative: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["positive", 0] } },
    latent: { class_type: "EmptyFlux2LatentImage", inputs: { width: p.width, height: p.height, batch_size: 1 } },
    schedule: { class_type: "Flux2Scheduler", inputs: { steps: p.steps, width: p.width, height: p.height } },
    noise: { class_type: "RandomNoise", inputs: { noise_seed: p.seed } },
    sampler: { class_type: "KSamplerSelect", inputs: { sampler_name: p.sampler } },
  };
  let positive: GraphLink = ["positive", 0], negative: GraphLink = ["negative", 0];
  for (const [index, image] of images.entries()) {
    const prefix = `reference_${index}`;
    graph[prefix] = { class_type: "LoadImage", inputs: { image: imageName(image) } };
    graph[`${prefix}_size`] = { class_type: "ImageScaleToTotalPixels", inputs: { image: [prefix, 0], upscale_method: "lanczos", megapixels: 1, resolution_steps: 1 } };
    graph[`${prefix}_latent`] = { class_type: "VAEEncode", inputs: { pixels: [`${prefix}_size`, 0], vae: ["vae", 0] } };
    graph[`${prefix}_positive`] = { class_type: "ReferenceLatent", inputs: { conditioning: positive, latent: [`${prefix}_latent`, 0] } };
    graph[`${prefix}_negative`] = { class_type: "ReferenceLatent", inputs: { conditioning: negative, latent: [`${prefix}_latent`, 0] } };
    positive = [`${prefix}_positive`, 0]; negative = [`${prefix}_negative`, 0];
  }
  graph.guider = { class_type: "CFGGuider", inputs: { model: ["model", 0], positive, negative, cfg: p.cfg } };
  graph.sample = { class_type: "SamplerCustomAdvanced", inputs: { noise: ["noise", 0], guider: ["guider", 0], sampler: ["sampler", 0], sigmas: ["schedule", 0], latent_image: ["latent", 0] } };
  graph.decode = { class_type: "VAEDecode", inputs: { samples: ["sample", 0], vae: ["vae", 0] } };
  graph.output = { class_type: "SaveImage", inputs: { images: ["decode", 0], filename_prefix: "grav" } };
  return graph;
}

export function compileGeneration(request: GenerationRequest, model?: ModelManifest): ExecutionSnapshot {
  check(request && typeof request === "object" && !Array.isArray(request) && Object.keys(request).every(key => requestKeys.has(key)), "Unknown generation parameter.");
  check(Object.values(request).every(value => value !== null), "Generation parameters cannot be null.");
  model ??= getModel(request.modelId);
  validateModel(model);
  check(request.modelId === model.id, "The request and model manifest do not match.");
  const family = FAMILY_RECIPES[model.familyId];
  const operation = request.operation ?? "text-to-image";
  check((model.operations ?? family.operations).includes(operation), "This model does not support the selected operation.");
  const images = request.images ?? [];
  check(Array.isArray(images) && images.length <= family.maxReferences, "Too many images for this recipe.");
  images.forEach(validateInputImage);
  check(operation === "text-to-image" ? images.length === 0 : images.length > 0, operation === "text-to-image" ? "Text-to-image does not accept input images." : "This operation needs an input image.");
  const parameters = parametersFor({ ...request, operation }, model);
  const content: Omit<ExecutionSnapshot, "hash"> = {
    schemaVersion: 1,
    recipe: { familyId: family.id, revision: family.revision, operation },
    model: structuredClone(model), parameters, inputs: structuredClone(images),
    graph: model.familyId.startsWith("flux-2-klein") ? kleinGraph(model, parameters, images) : sampledGraph(model, parameters, images),
    outputs: [{ node: "output", field: "images" }],
  };
  return { ...content, hash: snapshotHash(content) };
}
