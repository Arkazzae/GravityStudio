import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectRuntimePrerequisites } from "../../scripts/doctor.ts";
import { createRuntimeDeployment } from "../../scripts/runtime-plan.ts";
import { readRuntimeDeployment, smokeRuntimeDeployment, startRuntimeDeployment, verifySmokeResult, writeRuntimeDeployment } from "../../scripts/runtime-control.ts";
import type { RuntimeRunner } from "../../scripts/runtime-control.ts";
import { dualR9700, triple3090 } from "../hardware/fixtures.ts";
import lock from "../../deploy/comfyui/runtime.lock.json" with { type: "json" };

test("prepare writes private reviewable artifacts and empty shared model folders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gravity-deploy-"));
  try {
    const plan = createRuntimeDeployment(dualR9700(), { dataDirectory: directory });
    const paths = await writeRuntimeDeployment(plan);
    assert.equal((await stat(paths.planFile)).mode & 0o777, 0o600);
    assert.equal((await readRuntimeDeployment(directory)).workers.length, 2);
    assert.deepEqual(JSON.parse(await readFile(paths.composeFile, "utf8")), plan.compose);
    assert.ok((await stat(join(directory, "models/checkpoints"))).isDirectory());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("startup is idempotent and refuses existing deployment drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gravity-start-"));
  try {
    const hardware = triple3090();
    const plan = createRuntimeDeployment(hardware, { dataDirectory: directory, gpuIds: [hardware.gpus[0].id] });
    const worker = plan.workers[0], imageId = `sha256:${"1".repeat(64)}`;
    let exists = false, imageExists = false, running = false, created = 0, started = 0, built = 0, drift = false;
    const run: RuntimeRunner = async ({ args }) => {
      if (args[0] === "build") { imageExists = true; built++; return { stdout: "", stderr: "" }; }
      if (args[0] === "create") { exists = true; created++; return { stdout: "container", stderr: "" }; }
      if (args[0] === "start") { running = true; started++; return { stdout: "", stderr: "" }; }
      if (args[0] === "image" && args[1] === "ls") return { stdout: imageExists ? imageId : "", stderr: "" };
      if (args[0] === "image" && args.includes("{{json .}}")) return { stdout: JSON.stringify({ Config: { Labels: { "io.gravity.runtime.revision": worker.runtimeRevision, "io.gravity.runtime.profile": worker.runtimeProfileId } } }), stderr: "" };
      if (args[0] === "image") return { stdout: imageId, stderr: "" };
      if (args[1] === "ls") return { stdout: exists ? worker.containerName : "", stderr: "" };
      return { stdout: JSON.stringify({ Image: imageId, Config: { Labels: { "io.gravity.owner": "gravity-studio", "io.gravity.deployment": drift ? "changed" : worker.deploymentHash, "io.gravity.runtime.revision": worker.runtimeRevision } }, State: { Running: running } }), stderr: "" };
    };
    await startRuntimeDeployment(plan, run);
    await startRuntimeDeployment(plan, run);
    assert.equal(created, 1);
    assert.equal(started, 1);
    assert.equal(built, 1);
    drift = true;
    await assert.rejects(startRuntimeDeployment(plan, run), /differs from the reviewed plan/);
    assert.equal(started, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("GPU smoke evidence is bound to a physical device and immutable runtime image", () => {
  const hardware = triple3090(), gpu = hardware.gpus[0];
  const plan = createRuntimeDeployment(hardware, { dataDirectory: "/tmp/gravity-smoke", gpuIds: [gpu.id] }), worker = plan.workers[0];
  const result = { schemaVersion: 1, passed: true, verifiedAt: new Date().toISOString(), runtime: { revision: worker.runtimeRevision, profileId: worker.runtimeProfileId, comfyCommit: lock.comfyui.commit },
    devices: [{ uuid: gpu.uuid, architecture: gpu.architecture, pciAddress: gpu.pciAddress }] };
  const evidence = verifySmokeResult(result, worker, gpu, `sha256:${"1".repeat(64)}`);
  assert.equal(evidence.verification?.gpuId, gpu.id);
  assert.equal(evidence.verification?.runtimeRevision, worker.runtimeRevision);
  assert.throws(() => verifySmokeResult({ ...result, devices: [{ ...result.devices[0], uuid: "GPU-different" }] }, worker, gpu, `sha256:${"1".repeat(64)}`), /different physical GPU/);
  assert.throws(() => verifySmokeResult(result, worker, gpu, "unpinned-image"), /immutable image/);
  assert.equal(verifySmokeResult(result, worker, { ...gpu, architecture: null }, `sha256:${"1".repeat(64)}`).verification, null);
});

test("preflight checks engine access and AMD device groups without launching containers", async () => {
  const commands: string[] = [];
  const result = await inspectRuntimePrerequisites(dualR9700(), "podman", {
    async command(file, args) { commands.push(`${file} ${args.join(" ")}`); return "{}"; },
    async deviceGroups() { return [44, 109]; },
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.supplementalGroupIds, [44, 109]);
  assert.ok(commands.includes("crun --version"));
  assert.ok(commands.every((command) => !/\b(run|start|create|build)\b/.test(command)));
});

test("missing NVIDIA CDI entries block Podman startup and retain actionable diagnostics", async () => {
  const result = await inspectRuntimePrerequisites(triple3090(), "podman", { async command() { return "{}"; }, async deviceGroups() { return []; } });
  assert.equal(result.ready, false);
  assert.ok(result.checks.some((check) => check.id === "nvidia-cdi" && check.status === "failed"));
});

test("a failed smoke test records failure evidence and exposes its bounded diagnostic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gravity-smoke-failure-"));
  try {
    const hardware = triple3090(), gpu = hardware.gpus[0];
    const plan = createRuntimeDeployment(hardware, { dataDirectory: directory, gpuIds: [gpu.id] }), worker = plan.workers[0];
    await writeRuntimeDeployment(plan);
    const run: RuntimeRunner = async ({ args }) => {
      if (args[0] === "exec") throw Object.assign(new Error("exit 1"), { stdout: JSON.stringify({ passed: false, error: "GPU kernel is unavailable for this architecture" }) });
      return { stdout: JSON.stringify({ Image: `sha256:${"1".repeat(64)}`, State: { Running: true }, Config: { Labels: { "io.gravity.owner": "gravity-studio", "io.gravity.deployment": worker.deploymentHash, "io.gravity.runtime.revision": worker.runtimeRevision } } }), stderr: "" };
    };
    await assert.rejects(smokeRuntimeDeployment(plan, hardware, { run, async idle() {} }), /GPU kernel is unavailable/);
    const saved = JSON.parse(await readFile(join(directory, "runtime/verification.json"), "utf8"));
    assert.equal(saved.results[0].verification.passed, false);
    assert.equal(saved.results[0].verification.gpuId, gpu.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
