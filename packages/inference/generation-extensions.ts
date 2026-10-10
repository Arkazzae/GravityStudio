import { InferenceError } from "./types.ts";
import { FAMILY_RECIPES, isRelativeFile } from "./catalog.ts";
import type { GenerationExtensionManifest, GenerationRequest, ModelManifest } from "./types.ts";

/** Pinned weights from the publisher/ComfyUI official workflows; no arbitrary file paths. */
export const GENERATION_EXTENSIONS: readonly GenerationExtensionManifest[] = [
  {
    id: "krea2-style-reference", name: "Krea 2 Style reference", revision: "1",
    kind: "style-reference", category: "image", familyIds: ["krea-2"],
    description: "Use one or two style reference images with the official Krea adapter.",
    license: "Krea 2 Community License",
    artifacts: [{
      role: "lora", folder: "loras", filename: "krea2_style_reference.safetensors",
      sha256: "f50df5a9e62e4be8aa926a63dd5bb1a64770c4004f763c1208007ae13daa82b8",
      source: "https://huggingface.co/Comfy-Org/Krea-2/resolve/eb1eddd3983a54678545a9b2c178c5853b30f7be/loras/krea2_style_reference.safetensors",
    }],
    memory: { ramBytes: 2_147_483_648, vramBytes: 1_073_741_824 },
  },
  {
    id: "krea2-darkbrush", name: "Krea 2 Dark brush", revision: "1",
    kind: "lora", category: "image", familyIds: ["krea-2"],
    description: "Dark brush style. Trigger phrase: monochrome ink wash style.",
    license: "Krea 2 Community License",
    trigger: "monochrome ink wash style",
    artifacts: [{
      role: "lora", folder: "loras", filename: "krea2_darkbrush.safetensors",
      sha256: "f47c4316dd93af66e0518c93b582f459571d4925b519133770c73a52cd5db7c6",
      source: "https://huggingface.co/Comfy-Org/Krea-2/resolve/eb1eddd3983a54678545a9b2c178c5853b30f7be/loras/krea2_darkbrush.safetensors",
    }],
    memory: { ramBytes: 2_147_483_648, vramBytes: 1_073_741_824 },
  },
  {
    id: "krea2-dotmatrix", name: "Krea 2 Dot matrix", revision: "1",
    kind: "lora", category: "image", familyIds: ["krea-2"],
    description: "Dot matrix style. Trigger phrase: monochrome stippling style.",
    license: "Krea 2 Community License",
    trigger: "monochrome stippling style",
    artifacts: [{
      role: "lora", folder: "loras", filename: "krea2_dotmatrix.safetensors",
      sha256: "805aa30d863347222485b9d3ce81642dbc70a73cebc95ab57219d98b878fceec",
      source: "https://huggingface.co/Comfy-Org/Krea-2/resolve/eb1eddd3983a54678545a9b2c178c5853b30f7be/loras/krea2_dotmatrix.safetensors",
    }],
    memory: { ramBytes: 2_147_483_648, vramBytes: 1_073_741_824 },
  },
  {
    id: "krea2-kidsdrawing", name: "Krea 2 Kids drawing", revision: "1",
    kind: "lora", category: "image", familyIds: ["krea-2"],
    description: "Kids drawing style. Trigger phrase: naive expressive sketch style.",
    license: "Krea 2 Community License",
    trigger: "naive expressive sketch style",
    artifacts: [{
      role: "lora", folder: "loras", filename: "krea2_kidsdrawing.safetensors",
      sha256: "8c1d45d204aeb4e34a7d9e16a7d473917592ba0048b03f4e03e037e3578ca500",
      source: "https://huggingface.co/Comfy-Org/Krea-2/resolve/eb1eddd3983a54678545a9b2c178c5853b30f7be/loras/krea2_kidsdrawing.safetensors",
    }],
    memory: { ramBytes: 2_147_483_648, vramBytes: 1_073_741_824 },
  },
  {
    id: "krea2-neondrip", name: "Krea 2 Neon drip", revision: "1",
    kind: "lora", category: "image", familyIds: ["krea-2"],
    description: "Neon drip style. Trigger phrase: textured abstract style.",
    license: "Krea 2 Community License",
    trigger: "textured abstract style",
    artifacts: [{
      role: "lora", folder: "loras", filename: "krea2_neondrip.safetensors",
      sha256: "a779c14435949eabae9ce0bface4320cad6672ef3547e8489107e3498d65e871",
      source: "https://huggingface.co/Comfy-Org/Krea-2/resolve/eb1eddd3983a54678545a9b2c178c5853b30f7be/loras/krea2_neondrip.safetensors",
    }],
    memory: { ramBytes: 2_147_483_648, vramBytes: 1_073_741_824 },
  },
  {
    id: "krea2-rainywindow", name: "Krea 2 Rainy window", revision: "1",
    kind: "lora", category: "image", familyIds: ["krea-2"],
    description: "Rainy window style. Trigger phrase: rainy window style.",
    license: "Krea 2 Community License",
    trigger: "rainy window style",
    artifacts: [{
      role: "lora", folder: "loras", filename: "krea2_rainywindow.safetensors",
      sha256: "7063a6f15ec6112ad3c06d79097b2a30a3ea7d9072821cb36021010d55989fe5",
      source: "https://huggingface.co/Comfy-Org/Krea-2/resolve/eb1eddd3983a54678545a9b2c178c5853b30f7be/loras/krea2_rainywindow.safetensors",
    }],
    memory: { ramBytes: 2_147_483_648, vramBytes: 1_073_741_824 },
  },
  {
    id: "krea2-retroanime", name: "Krea 2 Retro anime", revision: "1",
    kind: "lora", category: "image", familyIds: ["krea-2"],
    description: "Retro anime style. Trigger phrase: purple retro anime style.",
    license: "Krea 2 Community License",
    trigger: "purple retro anime style",
    artifacts: [{
      role: "lora", folder: "loras", filename: "krea2_retroanime.safetensors",
      sha256: "ca42107783d9e517c5d62cb9a9db9ab2ba4887d90e9dad97a9d1a7fe6ff14c56",
      source: "https://huggingface.co/Comfy-Org/Krea-2/resolve/eb1eddd3983a54678545a9b2c178c5853b30f7be/loras/krea2_retroanime.safetensors",
    }],
    memory: { ramBytes: 2_147_483_648, vramBytes: 1_073_741_824 },
  },
  {
    id: "krea2-softwatercolor", name: "Krea 2 Soft watercolor", revision: "1",
    kind: "lora", category: "image", familyIds: ["krea-2"],
    description: "Soft watercolor style. Trigger phrase: art deco watercolor style.",
    license: "Krea 2 Community License",
    trigger: "art deco watercolor style",
    artifacts: [{
      role: "lora", folder: "loras", filename: "krea2_softwatercolor.safetensors",
      sha256: "3805e8655f19fbcac116542685e3f78f3a642e8fbfb857b5352bb32a4b3d445a",
      source: "https://huggingface.co/Comfy-Org/Krea-2/resolve/eb1eddd3983a54678545a9b2c178c5853b30f7be/loras/krea2_softwatercolor.safetensors",
    }],
    memory: { ramBytes: 2_147_483_648, vramBytes: 1_073_741_824 },
  },
  {
    id: "krea2-sunsetblur", name: "Krea 2 Sunset blur", revision: "1",
    kind: "lora", category: "image", familyIds: ["krea-2"],
    description: "Sunset blur style. Trigger phrase: ethereal motion blur style.",
    license: "Krea 2 Community License",
    trigger: "ethereal motion blur style",
    artifacts: [{
      role: "lora", folder: "loras", filename: "krea2_sunsetblur.safetensors",
      sha256: "194abdd531ca190d32799f26ab5bab634aa5ba3f07b7a60ffb282657db8bf3a0",
      source: "https://huggingface.co/Comfy-Org/Krea-2/resolve/eb1eddd3983a54678545a9b2c178c5853b30f7be/loras/krea2_sunsetblur.safetensors",
    }],
    memory: { ramBytes: 2_147_483_648, vramBytes: 1_073_741_824 },
  },
  {
    id: "krea2-vintagetarot", name: "Krea 2 Vintage tarot", revision: "1",
    kind: "lora", category: "image", familyIds: ["krea-2"],
    description: "Vintage tarot style. Trigger phrase: vintage tarot style.",
    license: "Krea 2 Community License",
    trigger: "vintage tarot style",
    artifacts: [{
      role: "lora", folder: "loras", filename: "krea2_vintagetarot.safetensors",
      sha256: "8cca96c56658fb3ac5269f9ef2245bd07cbf1b7a189f517c8763470bb1385f9f",
      source: "https://huggingface.co/Comfy-Org/Krea-2/resolve/eb1eddd3983a54678545a9b2c178c5853b30f7be/loras/krea2_vintagetarot.safetensors",
    }],
    memory: { ramBytes: 2_147_483_648, vramBytes: 1_073_741_824 },
  },
  {
    id: "sdxl-refiner-1.0", name: "SDXL Refiner 1.0", revision: "1",
    kind: "refiner", category: "image", familyIds: ["sdxl"],
    description: "Official SDXL finishing stage (last 20% of sampling).",
    artifacts: [{
      role: "refiner", folder: "checkpoints", filename: "sd_xl_refiner_1.0.safetensors",
      sha256: "7440042bbdc8a24813002c09b6b69b64dc90fded4472613437b7f55f9b7d9c5f",
      source: "https://huggingface.co/stabilityai/stable-diffusion-xl-refiner-1.0/resolve/5d4cfe854c9a9a87939ff3653551c2b3c99a4356/sd_xl_refiner_1.0.safetensors",
    }],
    memory: { ramBytes: 8_589_934_592, vramBytes: 8_589_934_592 },
  },
  {
    id: "sdxl-clip-vision", name: "SDXL ReVision CLIP Vision G", revision: "1",
    kind: "vision", category: "image", familyIds: ["sdxl"],
    description: "Official SDXL ReVision image conditioning; conceptual guidance, not identity locking.",
    artifacts: [{
      role: "clip-vision", folder: "clip_vision", filename: "clip_vision_g.safetensors",
      sha256: "9908329b3ead722a693ea400fab1d7c9ec91d6736fd194a94d20d793457f9c2e",
      source: "https://huggingface.co/comfyanonymous/clip_vision_g/resolve/c716ef60d1b516d73b1bf56714bbd4f6214ac91d/clip_vision_g.safetensors",
    }],
    memory: { ramBytes: 5_368_709_120, vramBytes: 5_368_709_120 },
  },
];

export function resolveGenerationExtensions(request: GenerationRequest, model: ModelManifest, frozen?: readonly GenerationExtensionManifest[]): GenerationExtensionManifest[] {
  const ids = [...(request.loras ?? []).map(item => item.id), ...(request.refiner ? ["sdxl-refiner-1.0"] : []), ...(request.operation === "reference" && model.familyId === "sdxl" ? ["sdxl-clip-vision"] : []), ...(request.operation === "reference" && model.familyId === "krea-2" ? ["krea2-style-reference"] : [])];
  const source = frozen ?? GENERATION_EXTENSIONS;
  if (!Array.isArray(source)) throw new InferenceError("INVALID_INPUT", "Invalid frozen extensions.");
  if (frozen) frozen.forEach(validateGenerationExtension);
  if (frozen && (frozen.length !== ids.length || new Set(frozen.map(item => item.id)).size !== frozen.length)) throw new InferenceError("INVALID_INPUT", "Frozen extensions do not match the requested recipe.");
  return ids.map(id => {
    const item = source.find(candidate => candidate.id === id);
    if (!item) throw new InferenceError("INVALID_INPUT", "This extension does not support the selected model.");
    validateGenerationExtension(item);
    if (!item.familyIds.includes(model.familyId)) throw new InferenceError("INVALID_INPUT", "This extension does not support the selected model.");
    if ((request.loras ?? []).some(lora => lora.id === id) && item.kind !== "lora") throw new InferenceError("INVALID_INPUT", "Choose a supported style LoRA.");
    const expected = id === "sdxl-refiner-1.0" && request.refiner ? "refiner" : id === "sdxl-clip-vision" && request.operation === "reference" ? "vision" : id === "krea2-style-reference" && request.operation === "reference" ? "style-reference" : "lora";
    if (item.kind !== expected) throw new InferenceError("INVALID_INPUT", "The pinned extension kind does not match this recipe.");
    return structuredClone(item);
  });
}

export function validateGenerationExtension(item: GenerationExtensionManifest): void {
  const check = (condition: unknown, message: string): void => { if (!condition) throw new InferenceError("INVALID_MODEL", message); };
  check(item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).every(key => ["id", "name", "revision", "kind", "category", "description", "familyIds", "artifacts", "memory", "license", "licenseUrl", "trigger"].includes(key)), "Invalid generation extension manifest.");
  check(typeof item.id === "string" && /^[a-z0-9][a-z0-9._-]{0,95}$/.test(item.id) && typeof item.revision === "string" && /^[a-zA-Z0-9._-]{1,96}$/.test(item.revision), "Set a stable extension ID and revision.");
  check(["lora", "refiner", "vision", "style-reference"].includes(item.kind) && item.category === "image", "Unsupported generation extension kind.");
  check(typeof item.name === "string" && item.name.trim().length > 0 && item.name.length <= 160 && typeof item.description === "string" && item.description.length <= 4000, "Extension names and descriptions must be bounded text.");
  check(Array.isArray(item.familyIds) && item.familyIds.length > 0 && new Set(item.familyIds).size === item.familyIds.length && item.familyIds.every(id => Object.hasOwn(FAMILY_RECIPES, id)), "Choose supported extension families.");
  check(item.kind !== "lora" || !item.familyIds.includes("ideogram-4"), "Ideogram's dual-model recipe does not support imported LoRAs.");
  check(item.kind === "lora" || item.familyIds.length === 1 && item.familyIds[0] === (item.kind === "style-reference" ? "krea-2" : "sdxl"), "Unsupported extension family.");
  check(item.memory && Object.keys(item.memory).length === 2 && [item.memory.ramBytes, item.memory.vramBytes].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1024 ** 4), "Invalid extension memory reservation.");
  const role = item.kind === "refiner" ? "refiner" : item.kind === "vision" ? "clip-vision" : "lora";
  const folder = role === "refiner" ? "checkpoints" : role === "clip-vision" ? "clip_vision" : "loras";
  check(Array.isArray(item.artifacts) && item.artifacts.length === 1, "This extension needs exactly one pinned artifact.");
  for (const a of item.artifacts) {
    check(a && Object.keys(a).every(key => ["role", "folder", "filename", "source", "sha256"].includes(key)) && a.role === role && a.folder === folder && isRelativeFile(a.filename), "Invalid extension model artifact.");
    check(a.sha256 === undefined || /^[a-f0-9]{64}$/.test(a.sha256), "Invalid extension SHA-256.");
    if (a.source !== undefined) { let u: URL; try { u = new URL(a.source); } catch { throw new InferenceError("INVALID_MODEL", "Invalid extension source."); } check(u.protocol === "https:" && !u.username && !u.password, "Extension sources must use HTTPS without credentials."); }
  }
  for (const value of [item.license, item.trigger]) check(value === undefined || typeof value === "string" && value.length <= 4000, "Invalid extension text.");
  if (item.licenseUrl !== undefined) { let u: URL; try { u = new URL(item.licenseUrl); } catch { throw new InferenceError("INVALID_MODEL", "Invalid extension license URL."); } check(u.protocol === "https:" && !u.username && !u.password, "Invalid extension license URL."); }
}

/** Apply requested LoRAs before conditioning/sampling, retaining immutable filenames. */
export function appendGenerationExtensions(graph: import("./types.ts").WorkflowGraph, model: ModelManifest, p: import("./types.ts").ResolvedParameters, extensions: GenerationExtensionManifest[]): void {
  type Link = import("./types.ts").GraphLink;
  const originalModel: Link = model.familyId === "sdxl" ? ["checkpoint", 0] : ["model", 0];
  const originalClip: Link = model.familyId === "sdxl" ? ["checkpoint", 1] : ["clip", 0];
  let modelLink = originalModel, clipLink = originalClip;
  const before = Object.keys(graph);
  for (const [index, selected] of (p.loras ?? []).entries()) {
    const extension = extensions.find(item => item.id === selected.id)!;
    const id = `lora_${index}`;
    graph[id] = { class_type: model.familyId === "sdxl" ? "LoraLoader" : "LoraLoaderModelOnly", inputs: { model: modelLink, lora_name: extension.artifacts[0].filename, strength_model: selected.strength, ...(model.familyId === "sdxl" ? { clip: clipLink, strength_clip: selected.strength } : {}) } };
    modelLink = [id, 0]; if (model.familyId === "sdxl") clipLink = [id, 1];
    if (extension.trigger && selected.strength > 0) {
      const node = graph.positive;
      const field = node?.inputs.text !== undefined ? "text" : "prompt";
      if (node && typeof node.inputs[field] === "string") node.inputs[field] = `${extension.trigger}. ${node.inputs[field]}`;
    }
  }
  if (p.loras?.length) for (const id of before) for (const [key, value] of Object.entries(graph[id].inputs)) {
    if (!Array.isArray(value)) continue;
    if (value[0] === originalModel[0] && value[1] === originalModel[1]) graph[id].inputs[key] = modelLink;
    else if (model.familyId === "sdxl" && value[0] === originalClip[0] && value[1] === originalClip[1]) graph[id].inputs[key] = clipLink;
  }
  if (p.refiner) {
    const refiner = extensions.find(item => item.kind === "refiner")!;
    // KSampler preserves `steps` actual passes at partial denoise by taking the
    // tail of a longer schedule. The refiner must split that same tail rather
    // than changing the edit strength when its checkbox is enabled.
    const total = p.denoise > .9999 ? p.steps : Math.floor(p.steps / p.denoise);
    if (total > 10_000) throw new InferenceError("INVALID_INPUT", "Increase denoise strength to fit the SDXL refiner's sampling schedule.");
    const start = total - p.steps;
    const split = start + Math.max(1, Math.min(p.steps - 1, Math.floor(p.steps * .8)));
    const sample = graph.sample.inputs;
    graph.sample = { class_type: "KSamplerAdvanced", inputs: { ...sample, steps: total, add_noise: "enable", noise_seed: p.seed, start_at_step: start, end_at_step: split, return_with_leftover_noise: "enable" } };
    delete graph.sample.inputs.seed; delete graph.sample.inputs.denoise;
    graph.refiner = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: refiner.artifacts[0].filename } };
    graph.refiner_positive = { class_type: "CLIPTextEncode", inputs: { clip: ["refiner", 1], text: p.prompt } };
    graph.refiner_negative = { class_type: "CLIPTextEncode", inputs: { clip: ["refiner", 1], text: p.negativePrompt } };
    graph.refiner_sample = { class_type: "KSamplerAdvanced", inputs: { model: ["refiner", 0], positive: ["refiner_positive", 0], negative: ["refiner_negative", 0], latent_image: ["sample", 0], add_noise: "disable", noise_seed: p.seed, steps: total, cfg: p.cfg, sampler_name: p.sampler, scheduler: p.scheduler, start_at_step: split, end_at_step: total, return_with_leftover_noise: "disable" } };
    graph.decode.inputs.samples = ["refiner_sample", 0];
  }
}
