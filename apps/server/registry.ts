import { DEFAULT_MODELS, listModels, validateModel } from "../../packages/inference/catalog.ts";
import type { ModelManifest } from "../../packages/inference/types.ts";
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
