import { DEFAULT_MODELS, listModels, validateModel } from "../../packages/inference/catalog.ts";
import type { ModelManifest } from "../../packages/inference/types.ts";
import type { GenerationExtensionManifest } from "../../packages/inference/types.ts";
import { GENERATION_EXTENSIONS, validateGenerationExtension } from "../../packages/inference/generation-extensions.ts";
import type { Store } from "./store.ts";

const registryKey = "imported-models";

export function modelRegistry(store: Store): ModelManifest[] {
  return listModels([...DEFAULT_MODELS, ...(store.metadata<ModelManifest[]>(registryKey) ?? [])]);
}

export function saveImportedModel(store: Store, model: ModelManifest) {
  validateModel(model);
  if (DEFAULT_MODELS.some(item => item.id === model.id)) throw new Error("A downloaded checkpoint cannot replace a catalog model.");
  const models = store.metadata<ModelManifest[]>(registryKey) ?? [];
  const next = [...models.filter(item => item.id !== model.id), model];
  if (next.length > 200) throw new Error("The library can contain up to 200 imported checkpoints.");
  store.setMetadata(registryKey, listModels(next));
}

export function generationExtensionRegistry(store: Store): GenerationExtensionManifest[] {
  const extensions = [...GENERATION_EXTENSIONS, ...(store.metadata<GenerationExtensionManifest[]>("imported-generation-extensions") ?? [])];
  const ids = new Set<string>();
  for (const extension of extensions) {
    validateGenerationExtension(extension);
    if (ids.has(extension.id)) throw new Error("Generation extension IDs must be unique.");
    ids.add(extension.id);
  }
  return structuredClone(extensions);
}

export function saveImportedExtension(store: Store, extension: GenerationExtensionManifest) {
  validateGenerationExtension(extension);
  if (extension.kind !== "lora" || GENERATION_EXTENSIONS.some(item => item.id === extension.id)) throw new Error("An imported LoRA cannot replace a catalog extension.");
  const current = store.metadata<GenerationExtensionManifest[]>("imported-generation-extensions") ?? [];
  const next = [...current.filter(item => item.id !== extension.id), structuredClone(extension)];
  if (next.length > 200) throw new Error("The library can contain up to 200 imported LoRAs.");
  store.setMetadata("imported-generation-extensions", next);
}
