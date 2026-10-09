import assert from "node:assert/strict";
import test from "node:test";
import { assessRuntimeCompatibility, planWorkers, validateWorkerPlacements } from "../../packages/hardware/src/index.ts";
import type { RuntimeProfile, RuntimeVerification } from "../../packages/hardware/src/index.ts";
import { dualR9700, GIB, gpu, inventory, NOW, singleB100, triple3090 } from "./fixtures.ts";

test("2×R9700 and 3×3090 default to individual workers, not pooled VRAM", () => {
  for (const hardware of [dualR9700(), triple3090()]) {
    const plan = planWorkers(hardware);
    assert.equal(plan.workers.length, hardware.gpus.length);
    assert.ok(plan.workers.every((worker) => worker.gpuIds.length === 1 && worker.mode === "single-gpu"));
    assert.ok(plan.workers.every((worker) => worker.compatibility.status === "unverified"));
    assert.deepEqual(plan.diagnostics, []);
  }
});

test("a large B100 remains one worker while mixed vendors receive separate backends", () => {
  const b100 = planWorkers(singleB100());
  assert.equal(b100.workers.length, 1);
  assert.equal(b100.workers[0].usableVramBytes["nvidia:GPU-b100"], 190 * GIB);
  const mixed = planWorkers(inventory([gpu("amd:one", "amd", 32, "gfx1201"), gpu("nvidia:one", "nvidia", 24, "sm_86")]));
  assert.deepEqual(mixed.workers.map((worker) => worker.backend), ["rocm", "cuda"]);
});

test("runtime verification matches architecture, GPU, driver and image revision", () => {
  const device = triple3090().gpus[0];
  const profile: RuntimeProfile = { id: "cuda", backend: "cuda", revision: "image-sha-1", architectures: ["sm_86"] };
  const evidence: RuntimeVerification = { gpuId: device.id, architecture: "sm_86", driverVersion: device.driverVersion!, runtimeProfileId: "cuda", runtimeRevision: "image-sha-1", verifiedAt: NOW.toISOString(), source: "smoke-test", passed: true };
  assert.equal(assessRuntimeCompatibility(device, profile).status, "unverified");
  assert.equal(assessRuntimeCompatibility(device, profile, [evidence]).status, "runtime-verified");
  assert.equal(assessRuntimeCompatibility({ ...device, architecture: null }, profile, [evidence]).status, "unverified");
  assert.equal(assessRuntimeCompatibility({ ...device, driverVersion: "changed" }, profile, [evidence]).status, "unverified");
  assert.equal(assessRuntimeCompatibility(device, { ...profile, revision: "image-sha-2" }, [evidence]).status, "unverified");
  assert.equal(assessRuntimeCompatibility(device, { ...profile, architectures: ["sm_100"] }, [evidence]).status, "incompatible");
});

test("later failed smoke evidence overrides a previous success", () => {
  const device = triple3090().gpus[0];
  const profile: RuntimeProfile = { id: "cuda", backend: "cuda", revision: "r1" };
  const base: RuntimeVerification = { gpuId: device.id, architecture: "sm_86", driverVersion: device.driverVersion!, runtimeProfileId: "cuda", runtimeRevision: "r1", verifiedAt: NOW.toISOString(), source: "smoke-test", passed: true };
  assert.equal(assessRuntimeCompatibility(device, profile, [base, { ...base, passed: false, verifiedAt: new Date(NOW.getTime() + 1).toISOString() }]).status, "unverified");
});

test("multi-GPU grouping requires an explicit compatible profile and retains each device budget", () => {
  const hardware = dualR9700();
  const ids = hardware.gpus.map((device) => device.id);
  const profile: RuntimeProfile = { id: "h3-dual", backend: "rocm", revision: "r1", multiGpu: { minDevices: 2, maxDevices: 2, sameArchitecture: true } };
  const grouped = planWorkers(hardware, { runtimeProfiles: [profile], groups: [{ id: "video", gpuIds: ids, runtimeProfileId: profile.id }] });
  assert.equal(grouped.workers.length, 1);
  assert.deepEqual(grouped.workers[0].usableVramBytes, { "amd:9700a": 30 * GIB, "amd:9700b": 30 * GIB });
  assert.deepEqual(grouped.diagnostics, []);
  const unsupported = planWorkers(hardware, { groups: [{ id: "video", gpuIds: ids, runtimeProfileId: "comfyui-rocm" }] });
  assert.ok(unsupported.diagnostics.some((item) => item.code === "unsupported-gpu-group"));
});

test("invalid reservations and GPU assignments cannot become silently valid placements", () => {
  const hardware = triple3090();
  assert.throws(() => planWorkers(hardware, { reserveVramBytes: -1 }));
  const missing = planWorkers(hardware, { gpuIds: ["absent"] });
  assert.equal(missing.workers.length, 0);
  assert.ok(missing.diagnostics.some((item) => item.code === "unknown-gpu"));
  const normal = planWorkers(hardware);
  const overlap = validateWorkerPlacements(hardware, [normal.workers[0], { ...normal.workers[0], id: "other" }]);
  assert.ok(overlap.some((item) => item.code === "overlapping-placement"));
});

test("mixed backends cannot form a shard and incompatible architecture profiles are rejected", () => {
  const mixed = inventory([gpu("amd:one", "amd", 32, "gfx1201"), gpu("nvidia:one", "nvidia", 24, "sm_86")]);
  const profile: RuntimeProfile = { id: "dual", backend: "cuda", revision: "r1", architectures: ["sm_100"], multiGpu: { minDevices: 2, maxDevices: 2, sameArchitecture: true } };
  const plan = planWorkers(mixed, { runtimeProfiles: [profile], groups: [{ id: "mixed", gpuIds: mixed.gpus.map((item) => item.id), runtimeProfileId: profile.id }] });
  assert.ok(plan.diagnostics.some((item) => item.code === "backend-mismatch"));
  assert.ok(plan.diagnostics.some((item) => item.code === "unsupported-architecture"));
  assert.ok(plan.diagnostics.some((item) => item.code === "group-architecture-mismatch"));
});
