import type { CompatibilityResult, Diagnostic, GpuDevice, HardwareInventory, RuntimeProfile, RuntimeVerification, WorkerPlacement, WorkerPlan } from "./types.ts";

const GIB = 1024 ** 3;
/** Candidate backends, not a claim that a particular image supports every GPU. */
export const DEFAULT_RUNTIME_PROFILES: readonly RuntimeProfile[] = [
  { id: "comfyui-cuda", backend: "cuda", revision: "unconfigured" },
  { id: "comfyui-rocm", backend: "rocm", revision: "unconfigured" },
];
const backendFor = (gpu: GpuDevice) => gpu.vendor === "nvidia" ? "cuda" : "rocm";
const bytes = (value: number) => Number.isSafeInteger(value) && value >= 0;

export function assessRuntimeCompatibility(gpu: GpuDevice, profile: RuntimeProfile, evidence: readonly RuntimeVerification[] = []): CompatibilityResult {
  if (profile.backend !== backendFor(gpu)) return { status: "incompatible", reason: "The runtime backend does not match the GPU vendor." };
  if (!gpu.architecture) return { status: "unverified", reason: "The GPU architecture is unknown. A device name is insufficient to verify runtime support." };
  if (profile.architectures?.length && !profile.architectures.includes(gpu.architecture)) return { status: "incompatible", reason: "The runtime profile does not include this GPU architecture." };
  const matching = evidence.filter((item) => item.gpuId === gpu.id && item.architecture === gpu.architecture && item.driverVersion === gpu.driverVersion && item.runtimeProfileId === profile.id && item.runtimeRevision === profile.revision && item.source === "smoke-test" && Number.isFinite(Date.parse(item.verifiedAt)) && Date.parse(item.verifiedAt) <= Date.now() + 1000)
    .sort((a, b) => Date.parse(b.verifiedAt) - Date.parse(a.verifiedAt))[0];
  if (profile.revision !== "unconfigured" && matching?.passed) return { status: "runtime-verified", reason: "A smoke test passed for this GPU, driver and runtime revision. Model workloads still require their own validation." };
  return { status: "unverified", reason: matching && !matching.passed ? "The latest smoke test failed for this configuration." : "The GPU was detected, but this runtime has not passed a matching smoke test." };
}

export interface WorkerPlanOptions {
  gpuIds?: readonly string[];
  reserveVramBytes?: number;
  reserveRamBytes?: number;
  runtimeProfiles?: readonly RuntimeProfile[];
  verifications?: readonly RuntimeVerification[];
  /** Explicit groups replace individual workers; ungrouped GPUs stay independent. */
  groups?: readonly { id: string; gpuIds: readonly string[]; runtimeProfileId: string }[];
}

export function validateWorkerPlacements(inventory: HardwareInventory, workers: readonly WorkerPlacement[], profiles: readonly RuntimeProfile[] = DEFAULT_RUNTIME_PROFILES): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const occupied = new Set<string>(), workerIds = new Set<string>();
  for (const worker of workers) {
    const error = (code: string, message: string) => diagnostics.push({ code, severity: "error", source: worker.id, message });
    if (!worker.id || workerIds.has(worker.id)) error("duplicate-worker", "Worker IDs must be nonempty and unique.");
    workerIds.add(worker.id);
    if (!worker.gpuIds.length || new Set(worker.gpuIds).size !== worker.gpuIds.length) error("invalid-placement", "A worker needs distinct GPU IDs.");
    const profile = profiles.find((item) => item.id === worker.runtimeProfileId);
    if (!profile || profile.backend !== worker.backend) error("unknown-runtime-profile", "The worker needs a matching runtime profile.");
    const devices: GpuDevice[] = [];
    for (const id of worker.gpuIds) {
      const gpu = inventory.gpus.find((item) => item.id === id);
      if (!gpu) error("unknown-gpu", `GPU ${id} is not in the detected inventory.`);
      else {
        devices.push(gpu);
        if (backendFor(gpu) !== worker.backend) error("backend-mismatch", "A worker cannot combine GPUs from different runtime backends.");
        if (profile?.architectures?.length && gpu.architecture && !profile.architectures.includes(gpu.architecture)) error("unsupported-architecture", "The selected runtime profile does not support this GPU architecture.");
        const usable = worker.usableVramBytes[id];
        if (!bytes(usable) || usable > gpu.memory.totalBytes) error("invalid-vram-budget", "Worker VRAM must fit on each assigned GPU independently.");
      }
      if (occupied.has(id)) error("overlapping-placement", `GPU ${id} is assigned to more than one worker.`);
      occupied.add(id);
    }
    if (worker.mode === "single-gpu" && worker.gpuIds.length !== 1) error("implicit-vram-pooling", "A single-GPU worker must have exactly one GPU.");
    if (worker.mode === "multi-gpu") {
      const group = profile?.multiGpu;
      if (!group || !Number.isInteger(group.minDevices) || !Number.isInteger(group.maxDevices) || group.minDevices < 2 || group.maxDevices < group.minDevices || worker.gpuIds.length < group.minDevices || worker.gpuIds.length > group.maxDevices) error("unsupported-gpu-group", "The runtime profile must explicitly support this number of GPUs.");
      if (group?.sameArchitecture && (devices.some((gpu) => !gpu.architecture) || new Set(devices.map((gpu) => gpu.architecture)).size !== 1)) error("group-architecture-mismatch", "This multi-GPU runtime requires the same known architecture on every device.");
    }
  }
  return diagnostics;
}

export function planWorkers(inventory: HardwareInventory, options: WorkerPlanOptions = {}): WorkerPlan {
  const profiles = options.runtimeProfiles ?? DEFAULT_RUNTIME_PROFILES;
  const reserveVramBytes = options.reserveVramBytes ?? 2 * GIB;
  const reserveRamBytes = options.reserveRamBytes ?? Math.min(8 * GIB, Math.floor(inventory.host.memory.totalBytes / 4));
  if (!bytes(reserveVramBytes) || !bytes(reserveRamBytes)) throw new TypeError("Memory reserves must be nonnegative integer byte counts.");
  const diagnostics: Diagnostic[] = [];
  const requested = options.gpuIds ?? inventory.gpus.map((gpu) => gpu.id);
  if (new Set(requested).size !== requested.length) diagnostics.push({ code: "duplicate-gpu", severity: "error", message: "Selected GPU IDs must be unique." });
  for (const id of requested) if (!inventory.gpus.some((gpu) => gpu.id === id)) diagnostics.push({ code: "unknown-gpu", severity: "error", source: id, message: "The selected GPU is no longer visible. Review the hardware configuration." });
  const selected = inventory.gpus.filter((gpu) => requested.includes(gpu.id));
  const grouped = new Set(options.groups?.flatMap((group) => [...group.gpuIds]));
  const definitions = [
    ...(options.groups ?? []).map((group) => ({ id: group.id, gpuIds: [...group.gpuIds], runtimeProfileId: group.runtimeProfileId, mode: "multi-gpu" as const })),
    ...selected.filter((gpu) => !grouped.has(gpu.id)).map((gpu) => ({ id: `media:${gpu.id}`, gpuIds: [gpu.id], runtimeProfileId: profiles.find((profile) => profile.backend === backendFor(gpu))?.id ?? "", mode: "single-gpu" as const })),
  ];
  const workers: WorkerPlacement[] = [];
  for (const definition of definitions) {
    const profile = profiles.find((item) => item.id === definition.runtimeProfileId);
    const devices = definition.gpuIds.map((id) => selected.find((gpu) => gpu.id === id));
    if (!profile || devices.some((gpu) => !gpu)) {
      diagnostics.push({ code: !profile ? "missing-runtime-profile" : "unknown-gpu", severity: "error", source: definition.id, message: !profile ? "No runtime profile matches this placement." : "A group references a GPU outside the selected hardware." });
      continue;
    }
    const gpus = devices as GpuDevice[];
    const results = gpus.map((gpu) => assessRuntimeCompatibility(gpu, profile, options.verifications));
    const compatibility = results.find((result) => result.status === "incompatible") ?? results.find((result) => result.status === "unverified") ?? results[0] ?? { status: "unverified" as const, reason: "No GPUs selected." };
    // Successful individual GPU smoke tests do not establish inter-device
    // communication or a model's distributed execution support.
    const groupCompatibility = definition.mode === "multi-gpu" && compatibility.status === "runtime-verified"
      ? { status: "unverified" as const, reason: "Individual GPUs passed smoke tests; this device group's communication and model execution remain unverified." } : compatibility;
    if (gpus.some((gpu) => gpu.memory.totalBytes <= reserveVramBytes)) diagnostics.push({ code: "insufficient-vram", severity: "error", source: definition.id, message: "A selected GPU has no VRAM remaining after the configured reserve." });
    workers.push({ ...definition, backend: profile.backend, usableVramBytes: Object.fromEntries(gpus.map((gpu) => [gpu.id, Math.max(0, gpu.memory.totalBytes - reserveVramBytes)])), compatibility: groupCompatibility });
  }
  diagnostics.push(...validateWorkerPlacements(inventory, workers, profiles));
  if (reserveRamBytes >= inventory.host.memory.totalBytes) diagnostics.push({ code: "insufficient-ram", severity: "error", message: "The RAM reserve leaves no memory available to model workers." });
  return { workers, reserveRamBytes, availableRamBytes: Math.max(0, inventory.host.memory.availableBytes - reserveRamBytes), diagnostics };
}
