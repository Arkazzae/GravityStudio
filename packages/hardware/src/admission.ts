import type { AdmissionResult, HardwareInventory, ResourceBudget, ResourceLease, ResourceTelemetry } from "./types.ts";

export function inventoryTelemetry(inventory: HardwareInventory): ResourceTelemetry {
  return { sampledAt: inventory.detectedAt, ram: { ...inventory.host.memory }, gpus: Object.fromEntries(inventory.gpus.filter((gpu) => gpu.memory.usedBytes !== null).map((gpu) => [gpu.id, { totalBytes: gpu.memory.totalBytes, availableBytes: Math.max(0, gpu.memory.totalBytes - gpu.memory.usedBytes!) }])) };
}

export interface AdmissionPolicy {
  reserveRamBytes?: number;
  reserveVramBytes?: number;
  maxTelemetryAgeMs?: number;
  now?: number;
  /** Default is exclusive GPU leases. Sharing must be explicitly configured. */
  allowGpuSharing?: boolean;
}

const bytes = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function validBudget(budget: ResourceBudget) { return budget && bytes(budget.ramBytes) && budget.gpus && typeof budget.gpus === "object" && !Array.isArray(budget.gpus) && Object.entries(budget.gpus).every(([id, amount]) => id.length > 0 && bytes(amount) && amount > 0); }
function validMemory(memory: { totalBytes: number; availableBytes: number }) { return memory && bytes(memory.totalBytes) && bytes(memory.availableBytes) && memory.totalBytes > 0 && memory.availableBytes <= memory.totalBytes; }

export function checkAdmission(request: ResourceBudget, telemetry: ResourceTelemetry, leases: readonly ResourceLease[] = [], policy: AdmissionPolicy = {}): AdmissionResult {
  const now = policy.now ?? Date.now(), maxAge = policy.maxTelemetryAgeMs ?? 15_000;
  const reserveRam = policy.reserveRamBytes ?? 0, reserveVram = policy.reserveVramBytes ?? 0;
  const deny = (code: AdmissionResult["code"], reason: string, gpuId?: string): AdmissionResult => ({ admitted: false, code, reason, ...(gpuId ? { gpuId } : {}) });
  if (!validBudget(request) || leases.some((lease) => !validBudget(lease.budget) || !lease.id) || new Set(leases.map((lease) => lease.id)).size !== leases.length || !bytes(reserveRam) || !bytes(reserveVram) || !bytes(maxAge) || maxAge === 0 || !Number.isFinite(now)) return deny("invalid-budget", "Resource budgets, lease IDs and reserves must be valid and distinct.");
  const fresh = (sampledAt: string) => { const age = now - Date.parse(sampledAt); return Number.isFinite(age) && age >= -1000 && age <= maxAge; };
  if (!fresh(telemetry.sampledAt) || !validMemory(telemetry.ram)) return deny("stale-telemetry", "Fresh, valid host memory telemetry is required.");
  for (const id of Object.keys(request.gpus)) {
    if (!validMemory(telemetry.gpus[id])) return deny("unknown-gpu", "Fresh capacity information is required for every assigned GPU.", id);
    if (!policy.allowGpuSharing && leases.some((lease) => Object.hasOwn(lease.budget.gpus, id))) return deny("gpu-busy", "The assigned GPU is reserved by another job.", id);
  }
  const identities = new Set<string>();
  let creditedRam = 0;
  const creditedVram: Record<string, number> = {};
  const remaining = leases.map((lease) => {
    const owned = lease.allocated;
    if (!owned || !owned.identity || identities.has(owned.identity) || !fresh(owned.sampledAt) || !validBudget(owned)) return lease.budget;
    identities.add(owned.identity);
    const ramCredit = Math.min(lease.budget.ramBytes, owned.ramBytes, Math.max(0, telemetry.ram.totalBytes - telemetry.ram.availableBytes - creditedRam));
    creditedRam += ramCredit;
    return { ramBytes: lease.budget.ramBytes - ramCredit, gpus: Object.fromEntries(Object.entries(lease.budget.gpus).map(([id, peak]) => {
      const device = telemetry.gpus[id];
      const used = validMemory(device) ? device.totalBytes - device.availableBytes : 0;
      const credit = Math.min(peak, owned.gpus[id] ?? 0, Math.max(0, used - (creditedVram[id] ?? 0)));
      creditedVram[id] = (creditedVram[id] ?? 0) + credit;
      return [id, peak - credit];
    })) };
  });
  const totalRamPeak = request.ramBytes + leases.reduce((sum, lease) => sum + lease.budget.ramBytes, 0) + reserveRam;
  const ramGrowth = request.ramBytes + remaining.reduce((sum, budget) => sum + budget.ramBytes, 0) + reserveRam;
  if (totalRamPeak > telemetry.ram.totalBytes || ramGrowth > telemetry.ram.availableBytes) return deny("insufficient-ram", "Combined model RAM and the host reserve exceed the available memory budget.");
  for (const [id, peak] of Object.entries(request.gpus)) {
    const device = telemetry.gpus[id];
    const totalPeak = peak + leases.reduce((sum, lease) => sum + (lease.budget.gpus[id] ?? 0), 0) + reserveVram;
    const growth = peak + remaining.reduce((sum, budget) => sum + (budget.gpus[id] ?? 0), 0) + reserveVram;
    if (totalPeak > device.totalBytes || growth > device.availableBytes) return deny("insufficient-vram", "The job's budget must fit on this GPU; free memory on other GPUs cannot be pooled.", id);
  }
  return { admitted: true, code: "ok", reason: "The job fits its assigned GPUs and the shared host RAM budget." };
}
