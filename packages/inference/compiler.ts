import { createHash, randomInt } from "node:crypto";
import { BIREFNET_ARTIFACT, FAMILY_RECIPES, effectiveModelOperations, effectiveModelQualityPresets, getModel, isRelativeFile, resolveModelOperation, validateModel } from "./catalog.ts";
import { fitImageSize, sourceCanvasSize, ultraOutputSize } from "../contracts/image-size.ts";
import { appendUltraGraph, getUpscaler } from "./upscale.ts";
import { compileIdeogramPrompt, parseIdeogramPrompt } from "./ideogram-prompt.ts";
import { appendGenerationExtensions, resolveGenerationExtensions } from "./generation-extensions.ts";
import { appendEditingGraph, appendIdeogramReference } from "./generation-editing.ts";
import { InferenceError } from "./types.ts";
import { effectiveModelLoraLimit, validateLoraChoices } from "./lora-stack.ts";
import type { ArtifactRole, BackgroundRemovalSnapshot, ExecutionSnapshot, GenerationExtensionManifest, GenerationRequest, GenerationSnapshot, GraphLink, InputImage, ModelManifest, ResolvedParameters, UpscalerManifest, UpscaleSnapshot, WorkflowGraph } from "./types.ts";

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function snapshotHash(snapshot: Omit<GenerationSnapshot, "hash"> | Omit<UpscaleSnapshot, "hash"> | Omit<BackgroundRemovalSnapshot, "hash">): string {
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

const requestKeys = new Set(["modelId", "operation", "prompt", "negativePrompt", "width", "height", "seed", "steps", "cfg", "sampler", "scheduler", "clipSkip", "denoise", "images", "background", "quality", "mask", "outpaint", "matchSource", "sourceSize", "refiner", "referenceStrength", "loras"]);

export function validateInputImage(image: InputImage): void {
  check(image && typeof image === "object" && Object.keys(image).every(key => ["filename", "subfolder", "type"].includes(key)), "Invalid input image reference.");
  check(image.type === "input" && isRelativeFile(image.filename) && !image.filename.includes("/"), "Choose an uploaded input image.");
  check(image.subfolder === "" || isRelativeFile(image.subfolder), "Invalid input image folder.");
}

function imageName(image: InputImage): string {
  return image.subfolder ? `${image.subfolder}/${image.filename}` : image.filename;
}

/** Bind worker uploads without rebuilding a durable job with a newer recipe. */
export function rebindGenerationInputs(snapshot: GenerationSnapshot, images: readonly InputImage[], mask?: InputImage): GenerationSnapshot {
  verifySnapshot(snapshot);
  check(["text-to-image", "image-to-image", "reference"].includes(snapshot.recipe.operation), "Choose a generation snapshot to bind.");
  check(Array.isArray(images) && images.length === snapshot.inputs.length, "Uploaded images must match the saved generation inputs.");
  check(!!mask === !!snapshot.mask, "The uploaded mask must match the saved generation mask.");
  const replacements = new Map<string, string>();
  const bind = (previous: InputImage, uploaded: InputImage): void => {
    validateInputImage(previous);
    validateInputImage(uploaded);
    const source = imageName(previous), target = imageName(uploaded);
    check(!replacements.has(source) || replacements.get(source) === target, "Repeated source images must use the same worker upload.");
    replacements.set(source, target);
  };
  snapshot.inputs.forEach((previous, index) => bind(previous, images[index]));
  if (snapshot.mask && mask) bind(snapshot.mask, mask);
  const { hash: _hash, ...content } = structuredClone(snapshot);
  const found = new Set<string>();
  for (const node of Object.values(content.graph)) {
    if (node.class_type !== "LoadImage" || typeof node.inputs.image !== "string") continue;
    const target = replacements.get(node.inputs.image);
    if (target === undefined) continue;
    found.add(node.inputs.image);
    node.inputs.image = target;
  }
  check(found.size === replacements.size, "The saved graph does not contain all generation inputs.");
  content.inputs = images.map(image => ({ ...image }));
  if (mask) content.mask = { ...mask };
  return { ...content, hash: snapshotHash(content) };
}

/** Preserve exact preset canvases; settle other shapes on the model's High grid. */
export function highImageSize(model: ModelManifest, width: number, height: number): { width: number; height: number } {
  return qualityImageSize(model, width, height, "high");
}

export function qualityImageSize(model: ModelManifest, width: number, height: number, quality: "fast" | "standard" | "high"): { width: number; height: number } {
  const family = FAMILY_RECIPES[model.familyId];
  const preset = effectiveModelQualityPresets(model).find(item => item.id === quality)!;
  const dimensions = { ...family.dimensions, min: Math.max(family.dimensions.min, preset.minSide ?? 0) };
  const defaults = { ...family.defaults, ...model.defaults };
  const sizeModel = { defaults, dimensions };
  for (const ratio of [1, 3 / 2, 2 / 3, 16 / 9, 9 / 16, 4 / 3, 3 / 4, 21 / 9, defaults.width / defaults.height]) {
    const size = fitImageSize(sizeModel, ratio, preset.pixels);
    if (size?.width === width && size.height === height) return size;
  }
  const ratio = width / height;
  let size = fitImageSize(sizeModel, ratio, preset.pixels);
  check(size, "This aspect ratio cannot fit the selected model quality.");
  const seen = new Set<string>();
  while (!seen.has(`${size.width}:${size.height}`)) {
    seen.add(`${size.width}:${size.height}`);
    const next = fitImageSize(sizeModel, size.width / size.height, preset.pixels);
    if (!next || Math.abs(next.width / next.height / ratio - 1) > .02) break;
    size = next;
  }
  return size;
}

function parametersFor(request: GenerationRequest, model: ModelManifest): ResolvedParameters {
  const family = FAMILY_RECIPES[model.familyId];
  const defaults = { ...family.defaults, ...model.defaults };
  check(typeof request.prompt === "string" && request.prompt.trim().length > 0 && request.prompt.length <= 16_000, "Write a prompt of 1–16,000 characters.");
  check(request.quality === undefined || ["fast", "standard", "high", "ultra"].includes(request.quality), "Choose Fast, Standard, High or Ultra quality.");
  const quality = request.quality === "ultra" ? "high" : request.quality;
  const sampling = effectiveModelQualityPresets(model).find(item => item.id === quality)?.sampling;
  const p: ResolvedParameters = {
    ...defaults,
    prompt: request.prompt,
    negativePrompt: request.negativePrompt ?? defaults.negativePrompt,
    width: request.width ?? defaults.width, height: request.height ?? defaults.height,
    seed: request.seed ?? randomInt(0, 2 ** 32), steps: request.steps ?? sampling?.steps ?? defaults.steps,
    cfg: request.cfg ?? sampling?.cfg ?? defaults.cfg, sampler: request.sampler ?? sampling?.sampler ?? defaults.sampler,
    scheduler: request.scheduler ?? sampling?.scheduler ?? defaults.scheduler, clipSkip: request.clipSkip ?? defaults.clipSkip,
    denoise: request.denoise ?? (request.operation === "image-to-image" ? 0.65 : 1),
    background: request.background ?? "auto",
  };
  if (request.quality !== undefined) p.quality = request.quality;
  const { min, max, multiple, maxPixels } = family.dimensions;
  check(["auto", "opaque", "transparent"].includes(p.background), "Choose an automatic, opaque or transparent background.");
  for (const value of [p.width, p.height]) check(Number.isInteger(value) && value >= min && value <= max && value % multiple === 0, `Dimensions must be multiples of ${multiple}, from ${min} to ${max}.`);
  for (const key of ["matchSource", "refiner"] as const) check(request[key] === undefined || typeof request[key] === "boolean", `Invalid ${key} setting.`);
  const sourceCanvas = !!(request.matchSource || request.mask || request.outpaint);
  if (sourceCanvas) {
    check(request.sourceSize && typeof request.sourceSize === "object" && Object.keys(request.sourceSize).every(key => ["width", "height"].includes(key)), "This edit requires trusted source dimensions.");
    const size = sourceCanvasSize({ defaults, dimensions: family.dimensions }, request.sourceSize, request.outpaint);
    check(size, "The source and padding cannot fit this model's canvas limits.");
    Object.assign(p, { width: size.width, height: size.height, matchSource: true, sourceSize: { ...request.sourceSize } });
  } else if (quality) Object.assign(p, qualityImageSize(model, p.width, p.height, quality));
  if (request.sourceSize !== undefined && !sourceCanvas) {
    check(typeof request.sourceSize === "object" && Object.keys(request.sourceSize).length === 2 && Object.keys(request.sourceSize).every(key => ["width", "height"].includes(key)) && [request.sourceSize.width, request.sourceSize.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 32768), "Invalid source dimensions.");
    p.sourceSize = { ...request.sourceSize };
  }
  if (request.outpaint) p.outpaint = { ...request.outpaint };
  if (request.refiner) p.refiner = true;
  if (request.referenceStrength !== undefined) {
    check(typeof request.referenceStrength === "number" && Number.isFinite(request.referenceStrength) && request.referenceStrength >= 0 && request.referenceStrength <= 2, "Reference strength must be between 0 and 2.");
    p.referenceStrength = request.referenceStrength;
  }
  if (request.loras?.length) p.loras = structuredClone(request.loras);
  if (model.familyId === "ideogram-4" && request.operation === "reference") { p.width = 1024; p.height = 1024; p.samplingWidth = 2048; p.samplingHeight = 1024; }
  if (model.familyId === "qwen-image-2.1" && request.images?.length && (p.width / 16) * (p.height / 16) % 2048 === 0) {
    p.samplingWidth = p.width + 32;
    p.samplingHeight = p.height + 32;
    check(p.samplingWidth * p.samplingHeight <= maxPixels, "The reference canvas exceeds this recipe's sampling pixel budget.");
  }
  check(p.width * p.height <= maxPixels, `This recipe supports at most ${maxPixels.toLocaleString("en")} pixels.`);
  check(Number.isSafeInteger(p.seed) && p.seed >= 0, "Seed must be a nonnegative safe integer.");
  check(Number.isInteger(p.steps) && p.steps >= 1 && p.steps <= 100, "Steps must be an integer from 1 to 100.");
  check(!p.refiner || p.steps >= 2, "The SDXL refiner requires at least two sampling steps.");
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
  } else if (model.familyId === "ideogram-4") {
    check(p.scheduler === "native", "Ideogram 4 uses its native resolution-aware scheduler.");
    check(!p.negativePrompt, "This Ideogram 4 recipe does not accept a negative prompt.");
    check(Math.max(p.width, p.height) / Math.min(p.width, p.height) <= 6, "Ideogram 4 supports aspect ratios from 1:6 to 6:1.");
  } else check(p.scheduler !== "native", "Select a ComfyUI scheduler for this family.");
  return p;
}

function artifact(model: ModelManifest, role: ArtifactRole): string {
  return model.artifacts.find(item => item.role === role)!.filename;
}

function sampledGraph(model: ModelManifest, p: ResolvedParameters, images: InputImage[], operation: GenerationRequest["operation"], extensions: GenerationExtensionManifest[]): WorkflowGraph {
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
  if (images.length && operation === "image-to-image") {
    graph.input_image = { class_type: "LoadImage", inputs: { image: imageName(images[0]) } };
    graph.resize = { class_type: "ImageScale", inputs: { image: ["input_image", 0], upscale_method: "lanczos", width: p.width, height: p.height, crop: "center" } };
    graph.latent = { class_type: "VAEEncode", inputs: { pixels: ["resize", 0], vae: vaeLink } };
  } else graph.latent = { class_type: "EmptyLatentImage", inputs: { width: p.width, height: p.height, batch_size: 1 } };
  graph.sample = { class_type: "KSampler", inputs: { model: modelLink, positive: ["positive", 0], negative: ["negative", 0], latent_image: ["latent", 0], seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: p.sampler, scheduler: p.scheduler, denoise: p.denoise } };
  if (operation === "reference" && model.familyId === "sdxl") {
    graph.vision = { class_type: "CLIPVisionLoader", inputs: { clip_name: extensions.find(item => item.kind === "vision")!.artifacts[0].filename } };
    let positive: GraphLink = ["positive", 0];
    for (const [index, image] of images.entries()) {
      graph[`reference_${index}`] = { class_type: "LoadImage", inputs: { image: imageName(image) } };
      graph[`vision_${index}`] = { class_type: "CLIPVisionEncode", inputs: { clip_vision: ["vision", 0], image: [`reference_${index}`, 0], crop: "center" } };
      graph[`revision_${index}`] = { class_type: "unCLIPConditioning", inputs: { conditioning: positive, clip_vision_output: [`vision_${index}`, 0], strength: p.referenceStrength ?? 1, noise_augmentation: 0 } };
      positive = [`revision_${index}`, 0];
    }
    graph.sample.inputs.positive = positive;
  } else if (operation === "reference" && model.familyId === "krea-2") {
    graph.style_adapter = { class_type: "LoraLoaderModelOnly", inputs: { model: modelLink, lora_name: extensions.find(item => item.kind === "style-reference")!.artifacts[0].filename, strength_model: p.referenceStrength ?? 1 } };
    graph.style_sampling = { class_type: "ModelSamplingFlux", inputs: { model: ["style_adapter", 0], max_shift: 1.15, base_shift: 0.5, width: p.width, height: p.height } };
    graph.positive = { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: clipLink, vae: vaeLink, prompt: p.prompt } };
    for (const [index, image] of images.entries()) {
      graph[`reference_${index}`] = { class_type: "LoadImage", inputs: { image: imageName(image) } };
      graph.positive.inputs[`image${index + 1}`] = [`reference_${index}`, 0];
    }
    graph.style_conditioning = { class_type: "FluxKontextMultiReferenceLatentMethod", inputs: { conditioning: ["positive", 0], reference_latents_method: "index_timestep_zero" } };
    graph.negative = { class_type: "ConditioningZeroOut", inputs: { conditioning: ["style_conditioning", 0] } };
    Object.assign(graph.sample.inputs, { model: ["style_sampling", 0], positive: ["style_conditioning", 0] });
  }
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

function qwenImage21Graph(model: ModelManifest, p: ResolvedParameters, images: InputImage[]): WorkflowGraph {
  // Reference edits can become noisy on these sampling grids in ComfyUI v0.39.0:
  // https://github.com/Comfy-Org/ComfyUI/issues/16435
  // Use a nearby grid, then restore the requested output size after decoding.
  const resizeOutput = !p.matchSource && p.samplingWidth !== undefined;
  const width = p.samplingWidth ?? p.width, height = p.samplingHeight ?? p.height;
  check(width * height <= FAMILY_RECIPES[model.familyId].dimensions.maxPixels, "The reference canvas exceeds this recipe's sampling pixel budget.");
  const prompt = p.background === "transparent"
    ? `This is an RGBA image with transparency. ${p.prompt} The image has alpha channel and the background is transparent.`
    : p.background === "opaque" ? `This is an opaque RGB image with a complete background. ${p.prompt} The image is fully opaque with no transparent areas or alpha channel.` : p.prompt;
  const graph: WorkflowGraph = {
    model: { class_type: "UNETLoader", inputs: { unet_name: artifact(model, "diffusion"), weight_dtype: "default" } },
    cache: { class_type: "QwenImage21Cache", inputs: { model: ["model", 0], device: "auto", dtype: "default" } },
    clip: { class_type: "CLIPLoader", inputs: { clip_name: artifact(model, "text-encoder"), type: "qwen_image", device: "default" } },
    vae: { class_type: "VAELoader", inputs: { vae_name: artifact(model, "vae") } },
    conditioning: { class_type: "TextEncodeQwenImage21", inputs: { clip: ["clip", 0], prompt, negative_prompt: p.negativePrompt, resolution: images.length ? 992 : 1024 } },
    // Reference encoding keeps aspect ratio and a separate, bounded pixel budget.
    latent: { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
  };
  if (images.length) graph.conditioning.inputs.vae = ["vae", 0];
  for (const [index, image] of images.entries()) {
    const id = `reference_${index}`;
    graph[id] = { class_type: "LoadImage", inputs: { image: imageName(image) } };
    graph[`${id}_rgba`] = { class_type: "JoinImageWithAlpha", inputs: { image: [id, 0], alpha: [id, 1] } };
    graph.conditioning.inputs[`images.image_${index + 1}`] = [`${id}_rgba`, 0];
    if (p.matchSource && index > 0) {
      graph[`${id}_bounded`] = { class_type: "ImageScaleToTotalPixels", inputs: { image: [`${id}_rgba`, 0], upscale_method: "lanczos", megapixels: 1, resolution_steps: 32 } };
      graph.conditioning.inputs[`images.image_${index + 1}`] = [`${id}_bounded`, 0];
    }
  }
  graph.sample = { class_type: "KSampler", inputs: { model: ["cache", 0], positive: ["conditioning", 0], negative: ["conditioning", 1], latent_image: ["latent", 0], seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: p.sampler, scheduler: p.scheduler, denoise: 1 } };
  graph.decode = { class_type: "VAEDecode", inputs: { samples: ["sample", 0], vae: ["vae", 0] } };
  if (resizeOutput) graph.output_resize = { class_type: "ImageScale", inputs: { image: ["decode", 0], upscale_method: "bicubic", width: p.width, height: p.height, crop: "disabled" } };
  graph.output = { class_type: "SaveImage", inputs: { images: [resizeOutput ? "output_resize" : "decode", 0], filename_prefix: "grav" } };
  return graph;
}

function ideogram4Graph(model: ModelManifest, p: ResolvedParameters, request: GenerationRequest): WorkflowGraph {
  // The publisher's CaptionVerifier requires background before elements;
  // style is optional. Keep the user's wording without a remote Magic Prompt.
  // https://github.com/ideogram-oss/ideogram4/blob/main/docs/prompting.md
  let prompt = p.prompt;
  if (request.operation === "reference") {
    const structured = parseIdeogramPrompt(prompt);
    const prefix = "A two-panel diptych. Left panel: the supplied character or subject reference. Right panel: the same subject in the following scene: ";
    if (structured) {
      structured.high_level_description = prefix + (structured.high_level_description ?? "the described composition");
      for (const element of structured.compositional_deconstruction.elements) {
        if (!element.bbox) continue;
        element.bbox[1] = 500 + Math.floor(element.bbox[1] / 2);
        element.bbox[3] = 500 + Math.ceil(element.bbox[3] / 2);
      }
      prompt = JSON.stringify(structured);
    } else prompt = prefix + prompt;
  }
  const caption = compileIdeogramPrompt(prompt);
  const quality = p.quality === "ultra" ? "high" : p.quality ?? "standard";
  const graph: WorkflowGraph = {
    model: { class_type: "UNETLoader", inputs: { unet_name: artifact(model, "diffusion"), weight_dtype: "default" } },
    model_negative: { class_type: "UNETLoader", inputs: { unet_name: artifact(model, "diffusion-unconditional"), weight_dtype: "default" } },
    clip: { class_type: "CLIPLoader", inputs: { clip_name: artifact(model, "text-encoder"), type: "ideogram4", device: "default" } },
    vae: { class_type: "VAELoader", inputs: { vae_name: artifact(model, "vae") } },
    positive: { class_type: "CLIPTextEncode", inputs: { clip: ["clip", 0], text: caption } },
    latent: { class_type: "EmptyFlux2LatentImage", inputs: { width: p.width, height: p.height, batch_size: 1 } },
    schedule: { class_type: "Ideogram4Scheduler", inputs: { steps: p.steps, width: p.width, height: p.height, mu: quality === "fast" ? .5 : 0, std: quality === "high" ? 1.5 : 1.75 } },
    // An absent negative socket gives the unconditional model no text tokens.
    // Zeroed text conditioning would still select its conditional code path.
    guider: { class_type: "DualModelGuider", inputs: { model: ["model", 0], model_negative: ["model_negative", 0], positive: ["positive", 0], cfg: p.cfg } },
    noise: { class_type: "RandomNoise", inputs: { noise_seed: p.seed } },
    sampler: { class_type: "KSamplerSelect", inputs: { sampler_name: p.sampler } },
    sample: { class_type: "SamplerCustomAdvanced", inputs: { noise: ["noise", 0], guider: ["guider", 0], sampler: ["sampler", 0], sigmas: ["schedule", 0], latent_image: ["latent", 0] } },
    decode: { class_type: "VAEDecode", inputs: { samples: ["sample", 0], vae: ["vae", 0] } },
    output: { class_type: "SaveImage", inputs: { images: ["decode", 0], filename_prefix: "grav" } },
  };
  if (request.operation === "image-to-image") {
    graph.input_image = { class_type: "LoadImage", inputs: { image: imageName(request.images![0]) } };
    graph.resize = { class_type: "ImageScale", inputs: { image: ["input_image", 0], upscale_method: "lanczos", width: p.width, height: p.height, crop: "center" } };
    graph.latent = { class_type: "VAEEncode", inputs: { pixels: ["resize", 0], vae: ["vae", 0] } };
    graph.denoise_schedule = { class_type: "SplitSigmasDenoise", inputs: { sigmas: ["schedule", 0], denoise: p.denoise } };
    graph.sample.inputs.sigmas = ["denoise_schedule", 1];
  }
  if (request.operation === "reference") appendIdeogramReference(graph, request);
  // Publisher profiles lower guidance for the final 3/2/1 actual steps.
  // A sigma percentage is not a step percentage. Continue the latent without
  // injecting fresh noise, preserving the same dual-model conditioning.
  const requestedPolish = Math.max(1, Math.round(p.steps * (quality === "high" ? 3 / 48 : quality === "fast" ? 1 / 12 : 2 / 20)));
  // SplitSigmasDenoise uses Python's round (ties to even), not Math.round.
  const retained = p.steps * p.denoise;
  const roundedSteps = retained % 1 === .5 ? 2 * Math.round(retained / 2) : Math.round(retained);
  const effectiveSteps = request.operation === "image-to-image" ? roundedSteps : p.steps;
  check(effectiveSteps > 0, "Denoise must retain at least one sampling step.");
  const mainSteps = Math.max(0, effectiveSteps - requestedPolish);
  if (mainSteps > 0) {
    graph.polish_schedule = { class_type: "SplitSigmas", inputs: { sigmas: graph.sample.inputs.sigmas, step: mainSteps } };
    graph.sample.inputs.sigmas = ["polish_schedule", 0];
    graph.polish = { class_type: "DualModelGuider", inputs: { ...graph.guider.inputs, cfg: Math.min(p.cfg, 3) } };
    graph.polish_noise = { class_type: "DisableNoise", inputs: {} };
    graph.sample_polish = { class_type: "SamplerCustomAdvanced", inputs: { noise: ["polish_noise", 0], guider: ["polish", 0], sampler: ["sampler", 0], sigmas: ["polish_schedule", 1], latent_image: ["sample", 0] } };
    graph.decode.inputs.samples = ["sample_polish", 0];
  } else graph.guider.inputs.cfg = Math.min(p.cfg, 3);
  return graph;
}

export function compileGeneration(request: GenerationRequest, model?: ModelManifest, upscaler?: UpscalerManifest, frozenExtensions?: readonly GenerationExtensionManifest[]): GenerationSnapshot {
  check(request && typeof request === "object" && !Array.isArray(request) && Object.keys(request).every(key => requestKeys.has(key)), "Unknown generation parameter.");
  check(Object.values(request).every(value => value !== null), "Generation parameters cannot be null.");
  model ??= getModel(request.modelId);
  validateModel(model);
  check(request.modelId === model.id, "The request and model manifest do not match.");
  const family = FAMILY_RECIPES[model.familyId];
  const images = request.images ?? [];
  const operation = resolveModelOperation(model, request.operation, Array.isArray(images) ? images.length : 0);
  check(effectiveModelOperations(model).includes(operation), "This model does not support the selected operation.");
  check(Array.isArray(images) && images.length <= family.maxReferences, "Too many images for this recipe.");
  images.forEach(validateInputImage);
  if (request.mask !== undefined) validateInputImage(request.mask);
  check(operation === "text-to-image" ? images.length === 0 : images.length > 0, operation === "text-to-image" ? "Text-to-image does not accept input images." : "This operation needs an input image.");
  check(operation !== "image-to-image" || images.length === 1, "Image-to-image takes exactly one source image.");
  const editing = !!(request.mask || request.outpaint);
  check(!(request.mask && request.outpaint), "Choose a mask or canvas extension, not both.");
  check(!editing || operation !== "text-to-image" && model.familyId !== "krea-2" && !(model.familyId === "sdxl" && operation === "reference") && !(model.familyId === "ideogram-4" && operation === "reference"), "This operation does not support a mask or canvas extension.");
  check(!request.matchSource || operation !== "text-to-image" && model.familyId !== "krea-2" && !(model.familyId === "sdxl" && operation === "reference") && !(model.familyId === "ideogram-4" && operation === "reference"), "Source matching is available for source image editing only.");
  if (request.outpaint) check(Object.values(request.outpaint).some(value => value > 0), "Extend at least one side of the source canvas.");
  check(!request.refiner || model.familyId === "sdxl", "The SDXL refiner only supports SDXL models.");
  check(request.referenceStrength === undefined || operation === "reference" && ["sdxl", "krea-2"].includes(model.familyId), "Reference strength is available for SDXL ReVision and Krea style references.");
  const maxLoras = effectiveModelLoraLimit(model);
  check(request.loras === undefined || validateLoraChoices(request.loras, maxLoras), `Choose up to ${maxLoras} distinct LoRAs with strengths from 0 to 2.`);
  const extensions = resolveGenerationExtensions({ ...request, operation }, model, frozenExtensions);
  const parameters = parametersFor({ ...request, operation }, model);
  const resolvedRequest = { ...request, operation, images };
  const graph = model.familyId.startsWith("flux-2-klein") ? kleinGraph(model, parameters, images) : model.familyId === "qwen-image-2.1" ? qwenImage21Graph(model, parameters, images) : model.familyId === "ideogram-4" ? ideogram4Graph(model, parameters, resolvedRequest) : sampledGraph(model, parameters, images, operation, extensions);
  appendEditingGraph(graph, model, parameters, resolvedRequest);
  appendGenerationExtensions(graph, model, parameters, extensions);
  const cutout = parameters.background === "transparent" && !family.nativeTransparency;
  const image = graph.output.inputs.images as GraphLink;
  if (cutout) {
    graph.background_model = { class_type: "LoadBackgroundRemovalModel", inputs: { bg_removal_name: BIREFNET_ARTIFACT.filename } };
    graph.background_mask = { class_type: "RemoveBackground", inputs: { bg_removal_model: ["background_model", 0], image } };
    // BiRefNet produces foreground opacity; JoinImageWithAlpha accepts the inverse mask.
    graph.background_invert = { class_type: "InvertMask", inputs: { mask: ["background_mask", 0] } };
    graph.background_rgba = { class_type: "JoinImageWithAlpha", inputs: { image, alpha: ["background_invert", 0] } };
    graph.output.inputs.images = ["background_rgba", 0];
  } else if (parameters.background === "opaque" && family.nativeTransparency) {
    // Composite after Qwen's output resize. Both composite images have three
    // channels, so even a generated RGBA canvas becomes a genuinely opaque PNG.
    graph.background_split = { class_type: "SplitImageWithAlpha", inputs: { image } };
    graph.background_opacity = { class_type: "InvertMask", inputs: { mask: ["background_split", 1] } };
    graph.background_white = { class_type: "EmptyImage", inputs: { width: parameters.width, height: parameters.height, batch_size: 1, color: 0xffffff } };
    graph.background_opaque = { class_type: "ImageCompositeMasked", inputs: { destination: ["background_white", 0], source: ["background_split", 0], mask: ["background_opacity", 0], x: 0, y: 0, resize_source: false } };
    graph.output.inputs.images = ["background_opaque", 0];
  }
  const postprocess = parameters.quality === "ultra" ? {
    model: structuredClone(upscaler ?? getUpscaler("seedvr2-7b")), ...ultraOutputSize(parameters.width, parameters.height),
  } : undefined;
  if (postprocess) appendUltraGraph(graph, postprocess.model, { width: postprocess.width, height: postprocess.height, seed: parameters.seed });
  const auxiliaryArtifacts = [...extensions.flatMap(item => item.artifacts), ...(cutout ? [structuredClone(BIREFNET_ARTIFACT)] : []), ...(postprocess?.model.artifacts ?? [])]
    .filter((item, index, artifacts) => !model.artifacts.some(base => base.folder === item.folder && base.filename === item.filename) && artifacts.findIndex(other => other.folder === item.folder && other.filename === item.filename) === index);
  const paths = new Map<string, string>();
  for (const item of [...model.artifacts, ...extensions.flatMap(extension => extension.artifacts), ...(postprocess?.model.artifacts ?? [])]) {
    const key = `${item.folder}/${item.filename}`, identity = item.sha256 ?? item.source ?? "";
    check(!paths.has(key) || paths.get(key) === identity, "Two model artifacts claim the same filename with different content.");
    paths.set(key, identity);
  }
  const content: Omit<GenerationSnapshot, "hash"> = {
    schemaVersion: 1,
    recipe: { familyId: family.id, revision: family.revision, operation },
    model: structuredClone(model), parameters, inputs: structuredClone(images),
    graph,
    ...(auxiliaryArtifacts.length ? { auxiliaryArtifacts } : {}),
    ...(postprocess ? { postprocess } : {}),
    ...(extensions.length ? { extensions } : {}),
    ...(request.mask ? { mask: structuredClone(request.mask) } : {}),
    outputs: [{ node: "output", field: "images" }],
  };
  return { ...content, hash: snapshotHash(content) };
}
