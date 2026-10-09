export type GpuVendor = "nvidia" | "amd";
export type RuntimeBackend = "cuda" | "rocm";

export interface Diagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  source?: string;
}

export interface GpuDevice {
  id: string;
  vendor: GpuVendor;
  name: string;
  /** Reported compute target, e.g. sm_86 or gfx1201; never inferred from a name. */
  architecture: string | null;
  pciAddress: string | null;
  uuid: string | null;
  memory: { totalBytes: number; usedBytes: number | null };
  driverVersion: string | null;
}

export interface HardwareInventory {
  schemaVersion: 1;
  detectedAt: string;
  host: {
    platform: string;
    architecture: string;
    logicalCpuCount: number;
    memory: { totalBytes: number; availableBytes: number };
    /** Detection sees this process's namespace, which may expose only some GPUs. */
    container: { detected: boolean; markers: string[] };
  };
  gpus: GpuDevice[];
  diagnostics: Diagnostic[];
}

/** Injectable boundary: fixtures can exercise detection without host commands. */
export interface HardwareProbe {
  platform: string;
  architecture: string;
  logicalCpuCount: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  readFile(path: string): Promise<string>;
  readDirectory(path: string): Promise<string[]>;
  realpath(path: string): Promise<string>;
  command(file: string, args: string[], options: { timeoutMs: number; maxOutputBytes: number }): Promise<string>;
}

export interface RuntimeProfile {
  id: string;
  backend: RuntimeBackend;
  /** Change when the image, dependencies or execution configuration changes. */
  revision: string;
  architectures?: readonly string[];
  multiGpu?: { minDevices: number; maxDevices: number; sameArchitecture: boolean };
}

export interface RuntimeVerification {
  gpuId: string;
  architecture: string;
  driverVersion: string;
  runtimeProfileId: string;
  runtimeRevision: string;
  verifiedAt: string;
  source: "smoke-test";
  passed: boolean;
}

export interface CompatibilityResult {
  status: "incompatible" | "unverified" | "runtime-verified";
  reason: string;
}

export interface WorkerPlacement {
  id: string;
  gpuIds: string[];
  backend: RuntimeBackend;
  mode: "single-gpu" | "multi-gpu";
  runtimeProfileId: string;
  usableVramBytes: Record<string, number>;
  compatibility: CompatibilityResult;
}

export interface WorkerPlan {
  workers: WorkerPlacement[];
  reserveRamBytes: number;
  availableRamBytes: number;
  diagnostics: Diagnostic[];
}

export interface ResourceBudget {
  ramBytes: number;
  /** Independent physical-device budgets; never an aggregate VRAM pool. */
  gpus: Record<string, number>;
}

export interface ResourceTelemetry {
  sampledAt: string;
  ram: { totalBytes: number; availableBytes: number };
  gpus: Record<string, { totalBytes: number; availableBytes: number }>;
}

export interface ResourceLease {
  id: string;
  budget: ResourceBudget;
  /** Only fresh measurements owned by this lease can reduce a reservation. */
  allocated?: ResourceBudget & { sampledAt: string; identity: string };
}

export interface AdmissionResult {
  admitted: boolean;
  code: "ok" | "invalid-budget" | "stale-telemetry" | "unknown-gpu" | "gpu-busy" | "insufficient-ram" | "insufficient-vram";
  reason: string;
  gpuId?: string;
}
