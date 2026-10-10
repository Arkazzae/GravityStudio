import { createHash } from "node:crypto";
import { DEFAULT_MODELS, FAMILY_RECIPES, effectiveModelOperations, effectiveModelQualityPresets, resolveModelOperation, validateModel } from "./catalog.ts";
import { InferenceError } from "./types.ts";
import { effectiveModelLoraLimit } from "./lora-stack.ts";
import type { GenerationRequest, ModelArtifact, ModelManifest, ModelPreset, Operation, SamplingDefaults } from "./types.ts";

export interface CheckpointManifestInput {
  id: string;
  name: string;
  /** Complete replacement descriptors, keyed by their artifact role. */
  artifacts: readonly ModelArtifact[];
  defaults?: Partial<SamplingDefaults>;
  operations?: readonly Operation[];
}

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

/** Recompute after every artifact is pinned; no single file represents a bundle. */
export function modelManifestRevision(model: ModelManifest): string {
  const { revision: _revision, ...content } = model;
  return createHash("sha256").update(canonical({ ...content, artifacts: [...model.artifacts].sort((a, b) => a.role.localeCompare(b.role)) })).digest("hex");
}

/** Only shipped, reviewed templates are advertised; a family alone is not a preset. */
export function getModelPresets(): ModelPreset[] {
  return DEFAULT_MODELS.map(model => {
    const primaryRole = model.familyId === "sdxl" ? "checkpoint" : "diffusion";
    return {
      id: model.id, name: model.name, revision: model.revision, familyId: model.familyId,
      primaryRole, dependencyRoles: model.artifacts.filter(artifact => artifact.role !== primaryRole).map(artifact => artifact.role),
      artifacts: structuredClone(model.artifacts), operations: effectiveModelOperations(model),
      defaults: { ...FAMILY_RECIPES[model.familyId].defaults, ...model.defaults }, qualityPresets: effectiveModelQualityPresets(model), maxLoras: effectiveModelLoraLimit(model),
    };
  });
}

/** Materialize within the same qualified recipe, never infer a recipe from a filename. */
export function createCheckpointManifest(input: CheckpointManifestInput, template: ModelManifest): ModelManifest {
  validateModel(template);
  const invalid = (condition: unknown, message: string): void => { if (condition) throw new InferenceError("INVALID_MODEL", message); };
  invalid(!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["id", "name", "artifacts", "defaults", "operations"].includes(key)), "Invalid checkpoint preset overrides.");
  invalid(!Array.isArray(input.artifacts) || !input.artifacts.length, "Replace the preset's primary checkpoint or diffusion weights.");
  invalid(input.defaults !== undefined && (!input.defaults || typeof input.defaults !== "object" || Array.isArray(input.defaults)), "Checkpoint defaults must be an object.");
  const primaryRole = template.familyId === "sdxl" ? "checkpoint" : "diffusion";
  const roles = new Set(template.artifacts.map(artifact => artifact.role));
  const overrides = new Map<ModelArtifact["role"], ModelArtifact>();
  for (const artifact of input.artifacts) {
    invalid(!artifact || typeof artifact !== "object" || !roles.has(artifact.role) || overrides.has(artifact.role), "Checkpoint overrides must use each supported artifact role at most once.");
    overrides.set(artifact.role, structuredClone(artifact));
  }
  invalid(!overrides.has(primaryRole), "Replace the preset's primary checkpoint or diffusion weights.");
  const allowedOperations = effectiveModelOperations(template);
  if (input.operations !== undefined) invalid(!Array.isArray(input.operations) || input.operations.some(operation => !allowedOperations.includes(operation)), "A checkpoint can only narrow its preset's operations.");
  // Defaults supplied for a checkpoint must survive the inherited quality controls.
  const tuning = Object.fromEntries(Object.entries(input.defaults ?? {}).filter(([key]) => ["steps", "cfg", "sampler", "scheduler"].includes(key)));
  // The substituted weights have their own terms; the recipe's license is not theirs.
  const { license: _license, licenseUrl: _licenseUrl, ...recipeTemplate } = structuredClone(template);
  const model: ModelManifest = {
    ...recipeTemplate, id: input.id, name: input.name, revision: "1",
    description: `Checkpoint configured with the ${template.name} preset.`,
    preset: { id: template.id, revision: template.revision },
    artifacts: template.artifacts.map(artifact => overrides.get(artifact.role) ?? structuredClone(artifact)),
    defaults: { ...FAMILY_RECIPES[template.familyId].defaults, ...template.defaults, ...input.defaults },
    operations: [...(input.operations ?? allowedOperations)],
    maxLoras: effectiveModelLoraLimit(template),
    qualityPresets: effectiveModelQualityPresets(template).map(preset => ({ ...preset, sampling: { ...preset.sampling, ...tuning } })),
  };
  validateModel(model);
  model.revision = modelManifestRevision(model);
  return model;
}

/** Probe a real allowed operation, including checkpoints that require an image. */
export function modelProbeRequest(model: ModelManifest, extra: Partial<GenerationRequest> = {}): GenerationRequest {
  const operation = resolveModelOperation(model, extra.operation, extra.images?.length ?? 0);
  return {
    prompt: "Capability check", seed: 0,
    ...(operation !== "text-to-image" ? { images: [{ filename: "capability.png", subfolder: "", type: "input" as const }], sourceSize: { width: 1024, height: 1024 } } : {}),
    ...extra, modelId: model.id, operation,
  };
}
