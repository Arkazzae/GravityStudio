import { FAMILY_RECIPES } from "./catalog.ts";
import type { ModelManifest } from "./types.ts";

export { MAX_LORAS, LEGACY_MAX_LORAS, validateLoraChoices } from "../contracts/lora-stack.ts";
export type { LoraChoice } from "../contracts/lora-stack.ts";

/** A workflow limit, not a claim about available GPU memory. Validate manifests first. */
export function effectiveModelLoraLimit(model: Pick<ModelManifest, "familyId" | "maxLoras">): number {
  return model.maxLoras ?? FAMILY_RECIPES[model.familyId].maxLoras;
}
