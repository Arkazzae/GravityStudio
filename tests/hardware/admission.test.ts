import assert from "node:assert/strict";
import test from "node:test";
import { checkAdmission, inventoryTelemetry } from "../../packages/hardware/src/index.ts";
import type { ResourceBudget, ResourceLease } from "../../packages/hardware/src/index.ts";
import { GIB, NOW, triple3090 } from "./fixtures.ts";

const policy = { now: NOW.getTime(), reserveRamBytes: 8 * GIB, reserveVramBytes: 2 * GIB };
const budget = (id: string, vramGiB = 20, ramGiB = 20): ResourceBudget => ({ ramBytes: ramGiB * GIB, gpus: { [id]: vramGiB * GIB } });

test("three independent GPU jobs can share sufficient host RAM without global serialization", () => {
  const hardware = triple3090();
  const telemetry = inventoryTelemetry(hardware);
  const active: ResourceLease[] = hardware.gpus.slice(0, 2).map((gpu, index) => ({ id: `job-${index}`, budget: budget(gpu.id) }));
  assert.equal(checkAdmission(budget(hardware.gpus[2].id), telemetry, active, policy).admitted, true);
});

test("RAM is shared across GPUs and admission refuses total overcommit", () => {
  const hardware = triple3090(), telemetry = inventoryTelemetry(hardware);
  const active: ResourceLease[] = hardware.gpus.slice(0, 2).map((gpu, index) => ({ id: `job-${index}`, budget: budget(gpu.id, 20, 35) }));
  assert.equal(checkAdmission(budget(hardware.gpus[2].id), telemetry, active, policy).code, "insufficient-ram");
});

test("a model cannot borrow free VRAM from another GPU", () => {
  const hardware = triple3090();
  const result = checkAdmission(budget(hardware.gpus[0].id, 30), inventoryTelemetry(hardware), [], policy);
  assert.equal(result.code, "insufficient-vram");
  assert.equal(result.gpuId, hardware.gpus[0].id);
});

test("stale telemetry, missing devices and exclusive reservations prevent admission", () => {
  const hardware = triple3090(), telemetry = inventoryTelemetry(hardware), request = budget(hardware.gpus[0].id);
  assert.equal(checkAdmission(request, { ...telemetry, sampledAt: new Date(NOW.getTime() - 16_000).toISOString() }, [], policy).code, "stale-telemetry");
  assert.equal(checkAdmission(budget("missing"), telemetry, [], policy).code, "unknown-gpu");
  assert.equal(checkAdmission(request, telemetry, [{ id: "active", budget: request }], policy).code, "gpu-busy");
});

test("fresh owned memory avoids counting active allocations twice", () => {
  const hardware = triple3090(), telemetry = inventoryTelemetry(hardware);
  telemetry.ram.availableBytes = 31 * GIB;
  const activeBudget = budget(hardware.gpus[0].id, 20, 50);
  const lease: ResourceLease = { id: "active", budget: activeBudget, allocated: { ...activeBudget, identity: "process-1", sampledAt: NOW.toISOString() } };
  const request = budget(hardware.gpus[1].id, 20, 20);
  assert.equal(checkAdmission(request, telemetry, [lease], policy).admitted, true);
  assert.equal(checkAdmission(request, telemetry, [{ ...lease, allocated: { ...lease.allocated!, sampledAt: new Date(NOW.getTime() - 60_000).toISOString() } }], policy).code, "insufficient-ram");
});

test("invalid budgets and duplicate leases cannot bypass resource accounting", () => {
  const hardware = triple3090(), telemetry = inventoryTelemetry(hardware), request = budget(hardware.gpus[0].id);
  assert.equal(checkAdmission({ ...request, ramBytes: -1 }, telemetry, [], policy).code, "invalid-budget");
  const lease = { id: "duplicate", budget: budget(hardware.gpus[1].id) };
  assert.equal(checkAdmission(request, telemetry, [lease, lease], policy).code, "invalid-budget");
});

test("GPU sharing requires explicit opt-in and still checks independent VRAM peaks", () => {
  const hardware = triple3090(), telemetry = inventoryTelemetry(hardware), id = hardware.gpus[0].id;
  const active = [{ id: "llm", budget: budget(id, 8, 8) }];
  assert.equal(checkAdmission(budget(id, 8, 8), telemetry, active, { ...policy, allowGpuSharing: true }).admitted, true);
  assert.equal(checkAdmission(budget(id, 16, 8), telemetry, active, { ...policy, allowGpuSharing: true }).code, "insufficient-vram");
});
