import { isIP } from "node:net";
import { ApiError, type ModelConfiguration, type StudioSettings, type WorkerSettings } from "../../packages/contracts/index.ts";
import { DEFAULT_MODELS, FAMILY_RECIPES, getModel, isRelativeFile } from "../../packages/inference/catalog.ts";
import type { ModelManifest } from "../../packages/inference/types.ts";
import type { HardwareInventory } from "../../packages/hardware/src/types.ts";
import { DEFAULT_SETTINGS, type Store } from "./store.ts";

const GiB = 1024 ** 3;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new ApiError(400, "INVALID_SETTINGS", message); }
function integer(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max; }
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
export function validateWorkerUrl(value: unknown): string {
  requireCondition(typeof value === "string" && value.length <= 2048, "Enter a ComfyUI server address.");
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(400, "INVALID_WORKER_URL", "Enter a complete http:// or https:// ComfyUI address."); }
  requireCondition(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, "Use an HTTP or HTTPS ComfyUI address without credentials, query or fragment.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  requireCondition(!["0.0.0.0", "::", "169.254.169.254"].includes(hostname) && !hostname.startsWith("169.254.") && !hostname.startsWith("fe80:") && !hostname.endsWith(".internal.google"), "Use the worker's reachable address, not an unspecified or metadata address.");
  if (isIP(hostname) === 4) requireCondition(Number(hostname.split(".")[0]) < 224, "Multicast addresses cannot be used for a worker.");
  return url.toString().replace(/\/$/, "");
}
export function defaultModelConfiguration(model: ModelManifest): ModelConfiguration {
  const budgets: Record<string, [number, number]> = {
    sdxl: [20, 12], "flux-2-klein-4b": [28, 20], "flux-2-klein-9b": [40, 28], "krea-2": [48, 28],
  };
  const [ram, vram] = budgets[model.familyId] ?? [48, 28];
  return { modelId: model.id, enabled: false, artifacts: Object.fromEntries(model.artifacts.map(item => [item.role, item.filename])), workerIds: [], memory: { ramBytes: ram * GiB, vramBytes: vram * GiB, source: "estimate" } };
}
export function settingsView(store: Store): StudioSettings {
  const current = store.settings();
  return { ...current, modelConfigurations: DEFAULT_MODELS.map(model => current.modelConfigurations.find(entry => entry.modelId === model.id) ?? defaultModelConfiguration(model)) };
}
export function configuredModel(configuration: ModelConfiguration): ModelManifest {
  const model = getModel(configuration.modelId);
  model.artifacts = model.artifacts.map(artifact => {
    const filename = configuration.artifacts[artifact.role] || artifact.filename;
    // A user-selected checkpoint is not verified against the catalog file hash.
    const { sha256: _sha, ...base } = artifact;
    return filename === artifact.filename ? { ...artifact } : { ...base, filename };
  });
  return model;
}
export function validateSettings(value: unknown, hardware: HardwareInventory): StudioSettings {
  requireCondition(object(value), "Settings must be an object.");
  requireCondition(integer(value.revision, 0, Number.MAX_SAFE_INTEGER), "Reload the current settings before saving.");
  requireCondition(Array.isArray(value.workers) && value.workers.length <= 64, "Configure at most 64 workers.");
  const workerIds = new Set<string>();
  const endpoints = new Set<string>();
  const workers: WorkerSettings[] = value.workers.map(raw => {
    requireCondition(object(raw) && id(raw.id) && !workerIds.has(raw.id), "Each worker needs a unique ID.");
    requireCondition(typeof raw.name === "string" && raw.name.trim().length > 0 && raw.name.length <= 120, "Give each worker a name.");
    requireCondition(typeof raw.enabled === "boolean", "Set whether each worker is enabled.");
    const baseUrl = validateWorkerUrl(raw.baseUrl);
    requireCondition(!endpoints.has(baseUrl), "Two workers cannot use the same ComfyUI endpoint.");
    requireCondition(raw.location === "local" || raw.location === "remote", "Choose whether the worker is local or remote.");
    requireCondition(Array.isArray(raw.deviceIds) && raw.deviceIds.length <= 1 && raw.deviceIds.every(device => typeof device === "string" && device.length > 0 && device.length <= 200), "Each image worker currently uses one GPU.");
    const deviceIds = raw.deviceIds as string[];
    if (raw.location === "local" && raw.enabled) {
      requireCondition(raw.deviceIds.length === 1, "Assign a detected GPU to each local worker.");
      requireCondition(hardware.gpus.some(gpu => gpu.id === deviceIds[0]), "The selected local GPU is no longer available. Detect hardware again.");
    }
    requireCondition(raw.maxConcurrentJobs === undefined || raw.maxConcurrentJobs === 1, "A ComfyUI worker executes one studio job at a time.");
    workerIds.add(raw.id); endpoints.add(baseUrl);
    return { id: raw.id, name: raw.name.trim(), enabled: raw.enabled, baseUrl, location: raw.location, deviceIds: raw.deviceIds as string[], maxConcurrentJobs: 1 };
  });
  requireCondition(Array.isArray(value.modelConfigurations) && value.modelConfigurations.length <= 256, "Provide the model configurations.");
  const modelIds = new Set<string>();
  const modelConfigurations: ModelConfiguration[] = value.modelConfigurations.map(raw => {
    requireCondition(object(raw) && typeof raw.modelId === "string" && !modelIds.has(raw.modelId), "Each model configuration must be unique.");
    const model = DEFAULT_MODELS.find(item => item.id === raw.modelId);
    requireCondition(model, "The model is not in this studio's catalog.");
    requireCondition(typeof raw.enabled === "boolean" && object(raw.artifacts), "Set model availability and model files.");
    const artifacts: Record<string, string> = {};
    for (const artifact of model.artifacts) {
      const filename = raw.artifacts[artifact.role] ?? artifact.filename;
      requireCondition(isRelativeFile(filename), `Choose a valid ${artifact.role} file.`);
      artifacts[artifact.role] = filename;
    }
    requireCondition(Array.isArray(raw.workerIds) && raw.workerIds.every(worker => typeof worker === "string" && workerIds.has(worker)) && new Set(raw.workerIds).size === raw.workerIds.length, "Assign models only to configured workers.");
    requireCondition(!raw.enabled || raw.workerIds.length > 0, "Assign an enabled model to at least one worker.");
    const memory = raw.memory ?? defaultModelConfiguration(model).memory;
    requireCondition(object(memory) && integer(memory.ramBytes, GiB, 8 * 1024 * GiB) && integer(memory.vramBytes, 256 * 1024 ** 2, 2 * 1024 * GiB), "Set positive RAM and VRAM budgets for this model.");
    // Only a completed calibration run may mark a budget as measured.
    modelIds.add(model.id);
    return { modelId: model.id, enabled: raw.enabled, artifacts, workerIds: raw.workerIds as string[], memory: { ramBytes: memory.ramBytes, vramBytes: memory.vramBytes, source: "estimate" } };
  });
  requireCondition(object(value.policy), "Provide resource and queue settings.");
  const policy = value.policy;
  requireCondition(integer(policy.ramReserveBytes, 0, 1024 * GiB) && integer(policy.vramReserveBytes, 0, 1024 * GiB), "Memory reserves must be nonnegative byte counts.");
  requireCondition(integer(policy.maxConcurrentJobs, 1, 64), "Run between 1 and 64 jobs at once.");
  const idleUnloadSeconds = policy.idleUnloadSeconds ?? DEFAULT_SETTINGS.policy.idleUnloadSeconds;
  requireCondition(integer(idleUnloadSeconds, 0, 86400), "The idle unload delay must be between 0 and 86400 seconds.");
  return { revision: value.revision, workers, modelConfigurations, policy: { ramReserveBytes: policy.ramReserveBytes, vramReserveBytes: policy.vramReserveBytes, maxConcurrentJobs: policy.maxConcurrentJobs, idleUnloadSeconds } };
}
export function modelCard(model: ModelManifest, configuration: ModelConfiguration, availableWorkerIds: string[]) {
  const family = FAMILY_RECIPES[model.familyId];
  const ready = configuration.enabled && configuration.workerIds.some(workerId => availableWorkerIds.includes(workerId));
  return {
    ...model, family: family.name, familyId: family.id,
    defaults: { ...family.defaults, ...model.defaults }, operations: model.operations ?? family.operations,
    dimensions: family.dimensions, requiredArtifactRoles: family.artifacts,
    ready, capabilities: { ready, maxImages: family.maxReferences, reference: family.maxReferences > 0 },
    missingReasons: configuration.enabled ? ready ? [] : ["Connect and verify a worker with the required model files."] : ["Enable this model in Hardware settings."],
  };
}
