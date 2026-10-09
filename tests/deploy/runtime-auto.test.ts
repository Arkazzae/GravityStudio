import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectRuntimePrerequisites, selectRuntimeEngine } from "../../scripts/doctor.ts";
import { prepareAutomaticRuntime } from "../../scripts/runtime-auto.ts";
import type { AutomaticRuntimeDependencies } from "../../scripts/runtime-auto.ts";
import { createRuntimeDeployment } from "../../scripts/runtime-plan.ts";
import { writeRuntimeDeployment } from "../../scripts/runtime-control.ts";
import { parseRuntimeArguments } from "../../scripts/runtime.ts";
import { dualR9700, triple3090 } from "../hardware/fixtures.ts";

function dependencies(overrides: Partial<AutomaticRuntimeDependencies> = {}): AutomaticRuntimeDependencies {
  return {
    async readPlan() { return null; },
    inspectPrerequisites(inventory, engine) {
      return inspectRuntimePrerequisites(inventory, engine, { async command() { return "{}"; }, async deviceGroups() { return [44, 109]; } });
    },
    async portAvailable() { return true; },
    async portOwnedByWorker() { return false; },
    ...overrides,
  };
}

test("automatic selection prefers ready Podman and skips occupied port ranges", async () => {
  const scanned: number[] = [];
  const result = await prepareAutomaticRuntime(dualR9700(), "/tmp/gravity-automatic", {}, dependencies({
    async portAvailable(port) { scanned.push(port); return port !== 8188 && port !== 8190; },
  }));
  assert.equal(result.preflight.ready, true);
  assert.equal(result.plan.engine, "podman");
  assert.deepEqual(result.plan.workers.map((worker) => worker.baseUrl), ["http://127.0.0.1:8191", "http://127.0.0.1:8192"]);
  assert.deepEqual(scanned, [8188, 8189, 8190, 8191, 8192]);
});

test("an installed engine without NVIDIA GPU integration loses to a ready alternative", async () => {
  const hardware = triple3090();
  for (const gpu of hardware.gpus) gpu.driverVersion = "580.126.09";
  const result = await selectRuntimeEngine(hardware, "auto", (inventory, engine) => inspectRuntimePrerequisites(inventory, engine, {
    async command(file, args) {
      if (file === "nvidia-ctk") return "";
      if (args.includes("{{json .Runtimes}}")) return '{"nvidia": {}}';
      return "{}";
    },
    async deviceGroups() { return []; },
  }));
  assert.equal(result.engine, "docker");
  assert.equal(result.preflight.ready, true);
  assert.ok(result.preflight.checks.some((check) => check.id === "nvidia-container-toolkit" && check.status === "passed"));
  assert.ok(!result.preflight.checks.some((check) => check.status === "failed"));
});

test("an explicit engine or port is respected and occupied ports block startup", async () => {
  const engines: string[] = [];
  const probe = dependencies();
  const result = await prepareAutomaticRuntime(dualR9700(), "/tmp/gravity-explicit", { engine: "docker", portBase: 9188 }, dependencies({
    async inspectPrerequisites(inventory, engine) { engines.push(engine ?? "docker"); return probe.inspectPrerequisites(inventory, engine); },
    async portAvailable(port) { return port !== 9189; },
  }));
  assert.deepEqual(engines, ["docker"]);
  assert.equal(result.plan.engine, "docker");
  assert.equal(result.plan.workers[0].baseUrl, "http://127.0.0.1:9188");
  assert.equal(result.preflight.ready, false);
  assert.ok(result.preflight.checks.some((check) => check.id === "worker-ports" && check.status === "failed"));
});

test("failed engine detection reports both prerequisite sets without creating state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gravity-no-engine-"));
  try {
    const probe = dependencies({
      inspectPrerequisites(inventory, engine) { return inspectRuntimePrerequisites(inventory, engine, {
        async command() { throw new Error("Engine unavailable"); }, async deviceGroups() { return [44, 109]; },
      }); },
      async portAvailable() { assert.fail("Do not scan ports when neither engine is ready."); },
    });
    const { readPlan: _readPlan, ...injected } = probe;
    const result = await prepareAutomaticRuntime(dualR9700(), directory, {}, injected);
    assert.equal(result.preflight.ready, false);
    assert.ok(result.preflight.checks.some((check) => check.id === "podman:container-engine" && check.status === "failed"));
    assert.ok(result.preflight.checks.some((check) => check.id === "docker:container-engine" && check.status === "failed"));
    await assert.rejects(access(join(directory, "runtime")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("saved deployment keeps its engine, selected GPUs, ports and custom worker options", async () => {
  const hardware = dualR9700();
  const saved = createRuntimeDeployment(hardware, { dataDirectory: "/tmp/gravity-saved", engine: "docker", portBase: 28188, gpuIds: [hardware.gpus[1].id], reserveVramGiB: 5, userId: 1234, groupId: 4567, supplementalGroupIds: [44, 109] });
  const inspected: string[] = [], ports: number[] = [];
  const probe = dependencies();
  const result = await prepareAutomaticRuntime(hardware, saved.dataDirectory, {}, dependencies({
    async readPlan() { return saved; },
    async inspectPrerequisites(inventory, engine) {
      inspected.push(engine!);
      assert.deepEqual(inventory.gpus.map((gpu) => gpu.id), [hardware.gpus[1].id]);
      return probe.inspectPrerequisites(inventory, engine);
    },
    async portAvailable(port) { ports.push(port); return false; },
    async portOwnedByWorker(plan, worker) { assert.equal(plan, saved); assert.equal(worker, saved.workers[0]); return true; },
  }));
  assert.equal(result.plan, saved);
  assert.equal(result.preflight.ready, true);
  assert.deepEqual(inspected, ["docker"]);
  assert.deepEqual(ports, [28188]);
  assert.ok(result.plan.workers[0].create.args.includes("GRAVITY_RESERVE_VRAM_GIB=5"));
  assert.ok(result.plan.workers[0].create.args.includes("1234:4567"));
});

test("saved deployment does not fall back to another engine or reassign an occupied port", async () => {
  const hardware = dualR9700();
  const saved = createRuntimeDeployment(hardware, { dataDirectory: "/tmp/gravity-saved-busy", engine: "docker", portBase: 28188, supplementalGroupIds: [44, 109] });
  const result = await prepareAutomaticRuntime(hardware, saved.dataDirectory, {}, dependencies({
    async readPlan() { return saved; }, async portAvailable() { return false; },
  }));
  assert.equal(result.plan, saved);
  assert.equal(result.preflight.ready, false);
  assert.ok(result.preflight.checks.some((check) => check.id.startsWith("worker-port:") && check.status === "failed"));

  const unavailable = await prepareAutomaticRuntime(hardware, saved.dataDirectory, {}, dependencies({
    async readPlan() { return saved; },
    async inspectPrerequisites(inventory, engine) {
      assert.equal(engine, "docker");
      return inspectRuntimePrerequisites(inventory, engine, { async command() { throw new Error("Docker unavailable"); }, async deviceGroups() { return [44, 109]; } });
    },
  }));
  assert.equal(unavailable.plan, saved);
  assert.equal(unavailable.preflight.ready, false);
});

test("saved deployment refuses changed selections, missing hardware and runtime drift", async () => {
  const hardware = dualR9700();
  const saved = createRuntimeDeployment(hardware, { dataDirectory: "/tmp/gravity-saved-drift", engine: "podman", portBase: 28188 });
  for (const options of [{ engine: "docker" as const }, { gpuIds: [hardware.gpus[0].id] }, { portBase: 8188 }]) {
    const result = await prepareAutomaticRuntime(hardware, saved.dataDirectory, options, dependencies({ async readPlan() { return saved; } }));
    assert.equal(result.plan, saved);
    assert.equal(result.preflight.ready, false);
  }
  const absent = await prepareAutomaticRuntime({ ...hardware, gpus: [hardware.gpus[0]] }, saved.dataDirectory, {}, dependencies({ async readPlan() { return saved; } }));
  assert.equal(absent.preflight.ready, false);
  assert.ok(absent.preflight.checks.some((check) => check.id.startsWith("saved-gpu:") && check.status === "failed"));
  const changed = structuredClone(saved);
  changed.workers[0].runtimeRevision = "0".repeat(64);
  const drift = await prepareAutomaticRuntime(hardware, saved.dataDirectory, {}, dependencies({ async readPlan() { return changed; } }));
  assert.equal(drift.preflight.ready, false);
  assert.ok(drift.preflight.checks.some((check) => check.id.startsWith("saved-runtime:") && check.status === "failed"));
});

test("unsupported GPU architecture fails automatic preflight before allocating ports", async () => {
  const hardware = dualR9700();
  hardware.gpus[0].architecture = "gfx0000";
  const result = await prepareAutomaticRuntime(hardware, "/tmp/gravity-unsupported", {}, dependencies({
    async portAvailable() { assert.fail("Unsupported plans cannot allocate ports."); },
  }));
  assert.equal(result.preflight.ready, false);
  assert.ok(result.preflight.checks.some((check) => check.id === "plan:unsupported-architecture"));
});

test("invalid saved files are reported without silently creating a replacement plan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gravity-invalid-plan-"));
  try {
    const saved = createRuntimeDeployment(dualR9700(), { dataDirectory: directory });
    await writeRuntimeDeployment(saved);
    const file = join(directory, "runtime/plan.json");
    await writeFile(file, "{broken");
    const { readPlan: _readPlan, ...injected } = dependencies();
    await assert.rejects(prepareAutomaticRuntime(dualR9700(), directory, {}, injected), SyntaxError);
    assert.equal(await readFile(file, "utf8"), "{broken");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CLI defaults to automatic engine and ports and accepts explicit overrides", () => {
  const automatic = parseRuntimeArguments(["up"]);
  assert.equal(automatic.engine, "auto");
  assert.equal(automatic.portBase, undefined);
  assert.equal(automatic.gpuIds, undefined);
  const explicit = parseRuntimeArguments(["up", "--engine", "podman", "--port", "28188", "--gpu", "amd:9700a"]);
  assert.equal(explicit.engine, "podman");
  assert.equal(explicit.portBase, 28188);
  assert.deepEqual(explicit.gpuIds, ["amd:9700a"]);
  assert.throws(() => parseRuntimeArguments(["up", "--port", "NaN"]));
});

test("selecting another GPU extends the saved plan without changing existing workers or images", async () => {
  const hardware = dualR9700();
  const saved = createRuntimeDeployment(hardware, { dataDirectory: "/tmp/gravity-expand", engine: "podman", gpuIds: [hardware.gpus[0].id], portBase: 8188, reserveVramGiB: 5 });
  const snapshot = structuredClone(saved);
  const result = await prepareAutomaticRuntime(hardware, saved.dataDirectory, { gpuIds: hardware.gpus.map((gpu) => gpu.id), expandSaved: true }, dependencies({
    async readPlan() { return saved; },
    // The old worker is stopped, so its port is free but remains reserved by the saved plan.
    async portAvailable(port) { return port !== 8189; },
  }));
  assert.equal(result.preflight.ready, true);
  assert.equal(result.plan.workers.length, 2);
  assert.equal(result.plan.workers[0], saved.workers[0]);
  assert.equal(result.plan.workers[1].baseUrl, "http://127.0.0.1:8190");
  assert.equal(result.plan.compose.services[saved.workers[0].id], saved.compose.services[saved.workers[0].id]);
  assert.equal(result.plan.build.length, 1);
  assert.equal(result.plan.build[0], saved.build[0]);
  assert.deepEqual(saved, snapshot);
});

test("a newly selected backend adds one build while preserving the original backend", async () => {
  const hardware = dualR9700();
  hardware.gpus.push(triple3090().gpus[0]);
  const saved = createRuntimeDeployment(hardware, { dataDirectory: "/tmp/gravity-expand-backend", engine: "podman", gpuIds: [hardware.gpus[0].id] });
  const result = await prepareAutomaticRuntime(hardware, saved.dataDirectory, { gpuIds: [hardware.gpus[2].id], expandSaved: true }, dependencies({
    async readPlan() { return saved; },
    async inspectPrerequisites(inventory, engine) {
      assert.equal(engine, "podman");
      assert.deepEqual(inventory.gpus.map((gpu) => gpu.id), [hardware.gpus[2].id]);
      return { ready: true, checks: [], supplementalGroupIds: [] };
    },
  }));
  assert.equal(result.preflight.ready, true);
  assert.equal(result.plan.workers.length, 2);
  assert.equal(result.plan.workers[0], saved.workers[0]);
  assert.equal(result.plan.workers[1].backend, "cuda");
  assert.equal(result.plan.build.length, 2);
  assert.equal(result.plan.build[0], saved.build[0]);
  assert.equal(result.plan.engine, saved.engine);
});

test("checkbox selection can exclude a removed GPU while retaining its saved identity and port", async () => {
  const hardware = dualR9700();
  const saved = createRuntimeDeployment(hardware, { dataDirectory: "/tmp/gravity-select-present", engine: "podman", portBase: 28188 });
  const current = { ...hardware, gpus: [hardware.gpus[1]] };
  const checkedPorts: number[] = [];
  const result = await prepareAutomaticRuntime(current, saved.dataDirectory, { gpuIds: [hardware.gpus[1].id], expandSaved: true }, dependencies({
    async readPlan() { return saved; },
    async portAvailable(port) { checkedPorts.push(port); return true; },
  }));
  assert.equal(result.preflight.ready, true);
  assert.equal(result.plan, saved);
  assert.deepEqual(checkedPorts, [28189]);
  const cli = await prepareAutomaticRuntime(current, saved.dataDirectory, {}, dependencies({ async readPlan() { return saved; } }));
  assert.equal(cli.preflight.ready, false);
});

test("unknown, repeated and unsupported GPU additions cannot alter the existing deployment", async () => {
  const hardware = dualR9700();
  hardware.gpus[1].architecture = "gfx0000";
  const saved = createRuntimeDeployment(hardware, { dataDirectory: "/tmp/gravity-expand-invalid", engine: "podman", gpuIds: [hardware.gpus[0].id] });
  for (const gpuIds of [[hardware.gpus[0].id, "missing"], [hardware.gpus[0].id, hardware.gpus[0].id], [hardware.gpus[0].id, hardware.gpus[1].id], []]) {
    const result = await prepareAutomaticRuntime(hardware, saved.dataDirectory, { gpuIds, expandSaved: true }, dependencies({ async readPlan() { return saved; } }));
    assert.equal(result.preflight.ready, false);
    assert.equal(result.plan, saved);
    assert.equal(saved.workers.length, 1);
  }
});
