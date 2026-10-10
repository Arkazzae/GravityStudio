import { InferenceError } from "./types.ts";
import { fitImageSize } from "../contracts/image-size.ts";
import { MAX_LORAS } from "../contracts/lora-stack.ts";
import type { ArtifactRole, FamilyId, FamilyRecipe, ImageQualityPreset, ModelArtifact, ModelManifest, Operation, SamplingDefaults } from "./types.ts";

export const BIREFNET_ARTIFACT: Readonly<ModelArtifact> = Object.freeze({
  role: "background-removal", folder: "background_removal", filename: "birefnet.safetensors",
  sha256: "9ab37426bf4de0567af6b5d21b16151357149139362e6e8992021b8ce356a154",
  source: "https://huggingface.co/Comfy-Org/BiRefNet/resolve/5a1bd8ae750548f8cd42e3c8afa854fd3eba0fb1/background_removal/birefnet.safetensors",
});
/** Conservative reservation for the core 1024-pixel BiRefNet pass; not a measured peak. */
export const BIREFNET_MEMORY = Object.freeze({ ramBytes: 4 * 1024 ** 3, vramBytes: 2 * 1024 ** 3 });

const base: SamplingDefaults = {
  width: 1024, height: 1024, steps: 30, cfg: 7,
  sampler: "euler", scheduler: "normal", negativePrompt: "", clipSkip: 1,
};

export const FAMILY_RECIPES: Readonly<Record<FamilyId, FamilyRecipe>> = {
  sdxl: {
    id: "sdxl", name: "SDXL / Illustrious", revision: "2",
    operations: ["text-to-image", "image-to-image", "reference"], artifacts: ["checkpoint"],
    defaults: base, dimensions: { multiple: 8, min: 256, max: 2048, maxPixels: 2_097_152 }, maxReferences: 4, maxLoras: MAX_LORAS,
    qualityPresets: [{ id: "fast", sampling: { steps: 20 }, pixels: 768 ** 2, minSide: 512 }, { id: "standard", sampling: { steps: 30 }, pixels: 896 ** 2, minSide: 512 }, { id: "high", sampling: { steps: 40 }, pixels: 1024 ** 2, minSide: 512 }],
  },
  "flux-2-klein-4b": {
    id: "flux-2-klein-4b", name: "FLUX.2 Klein 4B", revision: "2",
    operations: ["text-to-image", "reference"], artifacts: ["diffusion", "text-encoder", "vae"],
    defaults: { ...base, steps: 4, cfg: 1, scheduler: "native" },
    dimensions: { multiple: 16, min: 256, max: 2048, maxPixels: 2_097_152 }, maxReferences: 4, maxLoras: MAX_LORAS,
    qualityPresets: [{ id: "fast", sampling: { steps: 4 }, pixels: 768 ** 2 }, { id: "standard", sampling: { steps: 4 }, pixels: 1024 ** 2 }, { id: "high", sampling: { steps: 4 }, pixels: 2_097_152 }],
  },
  "flux-2-klein-9b": {
    id: "flux-2-klein-9b", name: "FLUX.2 Klein 9B", revision: "2",
    operations: ["text-to-image", "reference"], artifacts: ["diffusion", "text-encoder", "vae"],
    defaults: { ...base, steps: 4, cfg: 1, scheduler: "native" },
    dimensions: { multiple: 16, min: 256, max: 2048, maxPixels: 2_097_152 }, maxReferences: 4, maxLoras: MAX_LORAS,
    qualityPresets: [{ id: "fast", sampling: { steps: 4 }, pixels: 768 ** 2 }, { id: "standard", sampling: { steps: 4 }, pixels: 1024 ** 2 }, { id: "high", sampling: { steps: 4 }, pixels: 2_097_152 }],
  },
  "krea-2": {
    id: "krea-2", name: "Krea 2", revision: "2",
    operations: ["text-to-image", "reference"], artifacts: ["diffusion", "text-encoder", "vae"],
    defaults: { ...base, steps: 8, cfg: 1, scheduler: "simple" },
    dimensions: { multiple: 16, min: 256, max: 2048, maxPixels: 4_194_304 }, maxReferences: 2, maxLoras: MAX_LORAS,
    qualityPresets: [{ id: "fast", sampling: { steps: 8 }, pixels: 1024 ** 2 }, { id: "standard", sampling: { steps: 8 }, pixels: 2_097_152 }, { id: "high", sampling: { steps: 8 }, pixels: 4_194_304 }],
  },
  "qwen-image-2.1": {
    id: "qwen-image-2.1", name: "Qwen Image 2.1", revision: "3",
    nativeTransparency: true,
    operations: ["text-to-image", "reference"], artifacts: ["diffusion", "text-encoder", "vae"],
    defaults: { ...base, steps: 25, cfg: 1, scheduler: "simple" },
    dimensions: { multiple: 32, min: 256, max: 4096, maxPixels: 4_400_000 }, maxReferences: 10, maxLoras: MAX_LORAS,
    qualityPresets: [{ id: "fast", sampling: { steps: 8 }, pixels: 1024 ** 2 }, { id: "standard", sampling: { steps: 25 }, pixels: 2_097_152 }, { id: "high", sampling: { steps: 50 }, pixels: 4_194_304 }],
  },
  "ideogram-4": {
    id: "ideogram-4", name: "Ideogram 4", revision: "2",
    operations: ["text-to-image", "image-to-image", "reference"], artifacts: ["diffusion", "diffusion-unconditional", "text-encoder", "vae"],
    defaults: { ...base, steps: 20, cfg: 7, scheduler: "native" },
    dimensions: { multiple: 16, min: 256, max: 2048, maxPixels: 4_194_304 }, maxReferences: 1, maxLoras: 0,
    qualityPresets: [{ id: "fast", sampling: { steps: 12 }, pixels: 1024 ** 2 }, { id: "standard", sampling: { steps: 20 }, pixels: 2_097_152 }, { id: "high", sampling: { steps: 48 }, pixels: 4_194_304 }],
  },
};

/** These manifests describe existing worker files; discovery determines availability. No download occurs. */
export const DEFAULT_MODELS: readonly ModelManifest[] = [
  {
    id: "sdxl-base", name: "SDXL Base 1.0", familyId: "sdxl", revision: "1",
    description: "Text and image generation using the SDXL checkpoint recipe.", license: "CreativeML Open RAIL++-M",
    artifacts: [{ role: "checkpoint", folder: "checkpoints", filename: "sd_xl_base_1.0.safetensors", sha256: "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b", source: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/462165984030d82259a11f4367a4eed129e94a7b/sd_xl_base_1.0.safetensors" }],
  },
  {
    id: "wai-illustrious-v17", name: "WAI Illustrious v17", familyId: "sdxl", revision: "1",
    description: "An Illustrious fine-tune using the shared SDXL recipe.",
    defaults: { cfg: 7, sampler: "euler_ancestral", scheduler: "normal", clipSkip: 2, negativePrompt: "bad quality, worst quality, worst detail, sketch, censor" },
    artifacts: [{ role: "checkpoint", folder: "checkpoints", filename: "waiIllustriousSDXL_v170.safetensors", sha256: "f116b0c78ff441467b0cdc8f1936e1ed18ea31e9997c7b132b1b8db533f0bd04", source: "https://civitai.com/models/827184?modelVersionId=2883731" }],
  },
  {
    id: "flux-2-klein-4b", name: "FLUX.2 Klein 4B", familyId: "flux-2-klein-4b", revision: "2",
    description: "Distilled image generation and reference editing.", license: "Apache-2.0",
    artifacts: [
      { role: "diffusion", folder: "diffusion_models", filename: "flux-2-klein-4b.safetensors", sha256: "ec3d4e733a771f61c052fb4856c48b336c55eaf2c65487c2a1faeb9bbda7a343", source: "https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/blob/5f526678002e43af5551dadb73ce2e8c91b43afe/split_files/diffusion_models/flux-2-klein-4b.safetensors" },
      { role: "text-encoder", folder: "text_encoders", filename: "qwen_3_4b.safetensors", sha256: "6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a", source: "https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/blob/5f526678002e43af5551dadb73ce2e8c91b43afe/split_files/text_encoders/qwen_3_4b.safetensors" },
      { role: "vae", folder: "vae", filename: "flux2-vae.safetensors", sha256: "868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3", source: "https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/blob/5f526678002e43af5551dadb73ce2e8c91b43afe/split_files/vae/flux2-vae.safetensors" },
    ],
  },
  {
    id: "krea-2-turbo", name: "Krea 2 Turbo", familyId: "krea-2", revision: "1",
    description: "Text to image with the standard Krea 2 encoder and sampler.", license: "Krea 2 Community License",
    licenseUrl: "https://cdn.jsdelivr.net/gh/krea-ai/krea-2@db3984fbc6e13b34c0064990fc2d95ac64d00058/assets/hf_samples/LICENSE.pdf",
    artifacts: [
      { role: "diffusion", folder: "diffusion_models", filename: "krea2_turbo_fp8_scaled.safetensors", sha256: "eb4dd8c612cfd10f64f25b057e6e6bbcb5737c94a7372177e456dbf7579502f1", source: "https://huggingface.co/Comfy-Org/Krea-2/blob/e5ea8b4dd7f38f348b138eb0fe29f92c0e367e96/diffusion_models/krea2_turbo_fp8_scaled.safetensors" },
      { role: "text-encoder", folder: "text_encoders", filename: "qwen3vl_4b_bf16.safetensors", sha256: "36f3ff447ef59201722e8f9ce6020c9819fdcfba6aa2608c4e09b1c0ce114e34", source: "https://huggingface.co/Comfy-Org/Krea-2/blob/e5ea8b4dd7f38f348b138eb0fe29f92c0e367e96/text_encoders/qwen3vl_4b_bf16.safetensors" },
      { role: "vae", folder: "vae", filename: "qwen_image_vae.safetensors", sha256: "a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f", source: "https://huggingface.co/Comfy-Org/Krea-2/blob/e5ea8b4dd7f38f348b138eb0fe29f92c0e367e96/vae/qwen_image_vae.safetensors" },
    ],
  },
  {
    id: "qwen-image-2.1", name: "Qwen Image 2.1", familyId: "qwen-image-2.1", revision: "1",
    description: "BF16 image generation and instruction editing with up to ten references, including transparent PNG output.", license: "Qwen Research License (non-commercial)",
    licenseUrl: "https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE",
    artifacts: [
      { role: "diffusion", folder: "diffusion_models", filename: "qwen_image_2.1_bf16.safetensors", sha256: "89f4158d066cc33906a199fca85634f766892dd78f49b6698dabf187ac86c4bc", source: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/blob/cb504a4090723e43f17ad01cec0359490e2de613/diffusion_models/qwen_image_2.1_bf16.safetensors" },
      { role: "text-encoder", folder: "text_encoders", filename: "qwen3vl_8b_bf16.safetensors", sha256: "68bdc82bc1b66851162ae656225e7e2068166b603db19bd5d5a3b90eb12669a9", source: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/blob/cb504a4090723e43f17ad01cec0359490e2de613/text_encoders/qwen3vl_8b_bf16.safetensors" },
      { role: "vae", folder: "vae", filename: "qwen_image_2.1_vae_bf16.safetensors", sha256: "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9", source: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/blob/cb504a4090723e43f17ad01cec0359490e2de613/vae/qwen_image_2.1_vae_bf16.safetensors" },
    ],
  },
  {
    id: "ideogram-4-fp8", name: "Ideogram 4 FP8", familyId: "ideogram-4", revision: "1",
    description: "Local text-to-image generation for typography and detailed compositions.",
    license: "Ideogram Non-Commercial Model Agreement; commercial use requires a separate license",
    licenseUrl: "https://huggingface.co/ideogram-ai/ideogram-4-fp8/blob/main/LICENSE.md",
    artifacts: [
      { role: "diffusion", folder: "diffusion_models", filename: "ideogram4_fp8_scaled.safetensors", sha256: "49a946f1b0f8bcf5eab7d3b1ecc7b453c104e034cb1b592032745692724bd306", source: "https://huggingface.co/Comfy-Org/Ideogram-4/blob/2aa6c75ce6d5fabded0ca4d0f76abbfaf8edc87d/diffusion_models/ideogram4_fp8_scaled.safetensors" },
      { role: "diffusion-unconditional", folder: "diffusion_models", filename: "ideogram4_unconditional_fp8_scaled.safetensors", sha256: "9b359007dae162cca7591d00868feea733eb7c56e56e3a214a4d5a9a2a07cd60", source: "https://huggingface.co/Comfy-Org/Ideogram-4/blob/2aa6c75ce6d5fabded0ca4d0f76abbfaf8edc87d/diffusion_models/ideogram4_unconditional_fp8_scaled.safetensors" },
      { role: "text-encoder", folder: "text_encoders", filename: "qwen3vl_8b_fp8_scaled.safetensors", sha256: "4ba424cf62e51392e4d1a39933e803706f4e823c1065f36aaf149c6453f66bcd", source: "https://huggingface.co/Comfy-Org/Ideogram-4/blob/2aa6c75ce6d5fabded0ca4d0f76abbfaf8edc87d/text_encoders/qwen3vl_8b_fp8_scaled.safetensors" },
      { role: "vae", folder: "vae", filename: "flux2-vae.safetensors", sha256: "868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3", source: "https://huggingface.co/Comfy-Org/Ideogram-4/blob/2aa6c75ce6d5fabded0ca4d0f76abbfaf8edc87d/vae/flux2-vae.safetensors" },
    ],
  },
];

export function isRelativeFile(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\\\x00-\x1f\x7f:\[\]]/.test(value) && !value.startsWith("/") &&
    value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

const artifactFolders: Record<ArtifactRole, string> = {
  checkpoint: "checkpoints", diffusion: "diffusion_models", "diffusion-unconditional": "diffusion_models", "text-encoder": "text_encoders", vae: "vae",
  "background-removal": "background_removal",
  upscale: "upscale_models",
  "clip-vision": "clip_vision", lora: "loras", refiner: "checkpoints",
};
const allowedDefaults = new Set(Object.keys(base));

export function effectiveModelOperations(model: Pick<ModelManifest, "familyId" | "operations">): Operation[] {
  return [...(model.operations ?? FAMILY_RECIPES[model.familyId].operations)];
}

/** Preserve checkpoint sampling overrides when choosing an output quality. */
export function effectiveModelQualityPresets(model: Pick<ModelManifest, "familyId" | "defaults" | "qualityPresets">): ImageQualityPreset[] {
  const tuning = Object.fromEntries(Object.entries(model.defaults ?? {}).filter(([key]) => ["steps", "cfg", "sampler", "scheduler"].includes(key)));
  return (model.qualityPresets ?? FAMILY_RECIPES[model.familyId].qualityPresets).map(preset => ({
    ...structuredClone(preset), sampling: model.qualityPresets ? { ...tuning, ...preset.sampling } : { ...preset.sampling, ...tuning },
  }));
}

/** Choose an input variant only among operations explicitly allowed by the checkpoint. */
export function resolveModelOperation(model: Pick<ModelManifest, "familyId" | "operations">, operation?: Operation, imageCount = 0): Operation {
  const operations = effectiveModelOperations(model);
  if (operation !== undefined) return operation;
  if (imageCount > 0) return operations.includes("image-to-image") ? "image-to-image" : operations.includes("reference") ? "reference" : "text-to-image";
  return operations.includes("text-to-image") ? "text-to-image" : operations[0];
}

export function validateModel(manifest: ModelManifest): void {
  const fail = (message: string): never => { throw new InferenceError("INVALID_MODEL", message); };
  if (!manifest || typeof manifest !== "object") fail("A model manifest must be an object.");
  if (Object.keys(manifest).some(key => !["id", "name", "familyId", "revision", "artifacts", "defaults", "operations", "description", "license", "licenseUrl", "preset", "qualityPresets", "maxLoras"].includes(key))) fail("The model manifest has an unknown field.");
  if (typeof manifest.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(manifest.id)) fail("Model IDs use lowercase letters, numbers, dots, hyphens or underscores.");
  if (typeof manifest.name !== "string" || !manifest.name.trim() || manifest.name.length > 160) fail("Set a model name of at most 160 characters.");
  if (typeof manifest.revision !== "string" || !/^[a-zA-Z0-9._-]{1,96}$/.test(manifest.revision)) fail("Set a stable model revision.");
  if (manifest.preset !== undefined && (!manifest.preset || typeof manifest.preset !== "object" || Array.isArray(manifest.preset) || Object.keys(manifest.preset).length !== 2 || Object.keys(manifest.preset).some(key => !["id", "revision"].includes(key)) || typeof manifest.preset.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(manifest.preset.id) || typeof manifest.preset.revision !== "string" || !/^[a-zA-Z0-9._-]{1,96}$/.test(manifest.preset.revision))) fail("Set a valid reviewed preset identity and revision.");
  for (const value of [manifest.description, manifest.license]) if (value !== undefined && (typeof value !== "string" || value.length > 4000)) fail("Model descriptions and licenses must be bounded text.");
  if (manifest.licenseUrl !== undefined) {
    try {
      if (typeof manifest.licenseUrl !== "string" || manifest.licenseUrl.length > 2048) fail("Set a valid HTTPS license URL.");
      const url = new URL(manifest.licenseUrl);
      if (url.protocol !== "https:" || url.username || url.password) fail("License URLs must use HTTPS without credentials.");
    } catch { fail("Set a valid HTTPS license URL without credentials."); }
  }
  if (!Object.hasOwn(FAMILY_RECIPES, manifest.familyId)) fail("This model architecture has no recipe.");
  const family = FAMILY_RECIPES[manifest.familyId];
  if (manifest.maxLoras !== undefined && (!Number.isSafeInteger(manifest.maxLoras) || manifest.maxLoras < 0 || manifest.maxLoras > family.maxLoras)) fail("A checkpoint's LoRA limit cannot exceed its family's workflow policy.");
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== family.artifacts.length) fail("List exactly the model files required by the family.");
  const roles = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (!artifact || !family.artifacts.includes(artifact.role) || roles.has(artifact.role)) fail("Each required model role needs one artifact.");
    if (Object.keys(artifact).some(key => !["role", "folder", "filename", "sha256", "source"].includes(key))) fail("The model artifact has an unknown field.");
    roles.add(artifact.role);
    if (artifact.folder !== artifactFolders[artifact.role] || !isRelativeFile(artifact.filename)) fail("Model files must be relative to their matching ComfyUI model folder.");
    if (artifact.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(artifact.sha256)) fail("Model SHA-256 values use 64 lowercase hexadecimal characters.");
    if (artifact.source !== undefined) {
      try { const source = new URL(artifact.source); if (source.protocol !== "https:" || source.username || source.password) fail("Model source URLs must use HTTPS without credentials."); }
      catch { fail("Set a valid HTTPS model source URL."); }
    }
  }
  if (manifest.operations !== undefined && (!Array.isArray(manifest.operations) || !manifest.operations.length || new Set(manifest.operations).size !== manifest.operations.length || manifest.operations.some(op => !family.operations.includes(op)))) fail("A model can only enable operations its family supports.");
  if (manifest.defaults !== undefined) {
    if (!manifest.defaults || typeof manifest.defaults !== "object" || Array.isArray(manifest.defaults) || Object.keys(manifest.defaults).some(key => !allowedDefaults.has(key))) fail("The model has an unknown default parameter.");
    for (const [key, value] of Object.entries(manifest.defaults)) {
      const expected = typeof base[key as keyof SamplingDefaults];
      if (typeof value !== expected || typeof value === "number" && !Number.isFinite(value) || typeof value === "string" && value.length > 16_000) fail(`Invalid model default: ${key}.`);
    }
    const defaults = { ...family.defaults, ...manifest.defaults };
    if ([defaults.width, defaults.height].some(value => !Number.isInteger(value) || value < family.dimensions.min || value > family.dimensions.max || value % family.dimensions.multiple !== 0) || defaults.width * defaults.height > family.dimensions.maxPixels) fail("Model defaults must fit the recipe's canvas limits.");
    if (!Number.isInteger(defaults.steps) || defaults.steps < 1 || defaults.steps > 100 || defaults.cfg < 0 || defaults.cfg > 30 || !Number.isInteger(defaults.clipSkip) || defaults.clipSkip < 1 || defaults.clipSkip > 12 || manifest.familyId !== "sdxl" && defaults.clipSkip !== 1) fail("Invalid model default sampling bounds.");
    if ([defaults.sampler, defaults.scheduler].some(value => !/^[a-z0-9][a-z0-9_+.-]{0,95}$/i.test(value))) fail("Invalid model default sampling method.");
    const native = manifest.familyId.startsWith("flux-2-klein") || manifest.familyId === "ideogram-4";
    if (native !== (defaults.scheduler === "native") || native && defaults.negativePrompt) fail("Model defaults must preserve the recipe's scheduler and conditioning.");
  }
  const defaults = { ...family.defaults, ...manifest.defaults };
  if (manifest.familyId === "ideogram-4" && Math.max(defaults.width, defaults.height) / Math.min(defaults.width, defaults.height) > 6) fail("Ideogram 4 defaults support aspect ratios from 1:6 to 6:1.");
  if (manifest.qualityPresets !== undefined) {
    if (!Array.isArray(manifest.qualityPresets) || manifest.qualityPresets.length !== 3 || new Set(manifest.qualityPresets.map(preset => preset?.id)).size !== 3) fail("Define Fast, Standard and High quality exactly once.");
    for (const preset of manifest.qualityPresets) {
      if (!preset || typeof preset !== "object" || Object.keys(preset).some(key => !["id", "pixels", "minSide", "sampling"].includes(key)) || !["fast", "standard", "high"].includes(preset.id) || !Number.isSafeInteger(preset.pixels) || preset.pixels < family.dimensions.min ** 2 || preset.pixels > family.dimensions.maxPixels) fail("Invalid model quality preset.");
      if (preset.minSide !== undefined && (!Number.isSafeInteger(preset.minSide) || preset.minSide < family.dimensions.min || preset.minSide > family.dimensions.max)) fail("Invalid quality minimum side.");
      if (preset.sampling !== undefined) {
        if (!preset.sampling || typeof preset.sampling !== "object" || Array.isArray(preset.sampling) || Object.keys(preset.sampling).some(key => !["steps", "cfg", "sampler", "scheduler"].includes(key))) fail("Invalid quality sampling overrides.");
        for (const [key, value] of Object.entries(preset.sampling)) {
          if (key === "steps" ? !Number.isInteger(value) || Number(value) < 1 || Number(value) > 100 : key === "cfg" ? typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 30 : typeof value !== "string" || !/^[a-z0-9][a-z0-9_+.-]{0,95}$/i.test(value)) fail("Invalid quality sampling override.");
        }
      }
      const native = manifest.familyId.startsWith("flux-2-klein") || manifest.familyId === "ideogram-4";
      if (native !== ((preset.sampling?.scheduler ?? defaults.scheduler) === "native")) fail("Quality sampling must preserve the recipe's scheduler.");
    }
  }
  for (const preset of effectiveModelQualityPresets(manifest)) {
    const dimensions = { ...family.dimensions, min: Math.max(family.dimensions.min, preset.minSide ?? 0) };
    if (!fitImageSize({ defaults, dimensions }, defaults.width / defaults.height, preset.pixels)) fail("Model defaults must fit every quality preset's canvas grid.");
  }
}

export function listModels(models: readonly ModelManifest[] = DEFAULT_MODELS): ModelManifest[] {
  const seen = new Set<string>();
  for (const model of models) {
    validateModel(model);
    if (seen.has(model.id)) throw new InferenceError("INVALID_MODEL", `Duplicate model ID: ${model.id}.`);
    seen.add(model.id);
  }
  return structuredClone(models) as ModelManifest[];
}

export function getModel(id: string, models: readonly ModelManifest[] = DEFAULT_MODELS): ModelManifest {
  const model = models.find(item => item.id === id);
  if (!model) throw new InferenceError("MODEL_NOT_FOUND", "The selected model is not in the catalog.");
  validateModel(model);
  return structuredClone(model);
}
