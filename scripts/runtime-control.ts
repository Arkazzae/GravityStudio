import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { GpuDevice, HardwareInventory, RuntimeVerification } from "../packages/hardware/src/index.ts";
import type { ManagedWorker, RuntimeCommand, RuntimeDeployment } from "./runtime-plan.ts";
import { runtimeWorkerSettings } from "./runtime-plan.ts";
import lock from "../deploy/comfyui/runtime.lock.json" with { type: "json" };

export type RuntimeRunner = (command: RuntimeCommand, options?: { timeoutMs?: number; stream?: boolean }) => Promise<{ stdout: string; stderr: string }>;
export const executeRuntimeCommand: RuntimeRunner = (command, options = {}) => new Promise((resolve, reject) => {
  if (!["docker", "podman"].includes(command.program)) { reject(new Error("Unsupported container engine")); return; }
  const child = spawn(command.program, command.args, { stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
  let stdout = "", stderr = "", settled = false;
  const fail = (error: Error) => { if (settled) return; settled = true; clearTimeout(timer); child.kill("SIGKILL"); reject(error); };
  const timer = setTimeout(() => fail(new Error("Container command exceeded its time limit.")), options.timeoutMs ?? 30_000);
  child.stdout.on("data", (chunk: Buffer) => {
    if (options.stream) process.stderr.write(chunk);
    stdout += chunk.toString();
    if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) { if (options.stream) stdout = stdout.slice(-65536); else fail(new Error("Container command output exceeded its limit.")); }
  });
  child.stderr.on("data", (chunk: Buffer) => { if (options.stream) process.stderr.write(chunk); stderr = (stderr + chunk.toString()).slice(-65536); });
  child.once("error", fail);
  child.once("close", (code) => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    if (code === 0) resolve({ stdout, stderr });
    else reject(Object.assign(new Error(`Container command failed with exit code ${code ?? "unknown"}.${options.stream ? " See the build output above." : ""}`), { stdout, stderr }));
  });
});

async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function writeRuntimeDeployment(plan: RuntimeDeployment) {
  await mkdir(join(plan.dataDirectory, "runtime"), { recursive: true, mode: 0o700 });
  await mkdir(plan.modelsDirectory, { recursive: true, mode: 0o755 });
  for (const folder of ["checkpoints", "diffusion_models", "text_encoders", "clip", "vae", "loras", "controlnet", "clip_vision", "upscale_models", "embeddings"]) await mkdir(join(plan.modelsDirectory, folder), { recursive: true, mode: 0o755 });
  for (const worker of plan.workers) for (const folder of ["input", "output", "temp", "user"]) await mkdir(join(worker.stateDirectory, folder), { recursive: true, mode: 0o700 });
  await atomicJson(plan.composeFile, plan.compose);
  await atomicJson(join(plan.dataDirectory, "runtime", "plan.json"), plan);
  await atomicJson(join(plan.dataDirectory, "runtime", "workers.json"), { version: 1, kind: "gravity-worker-settings", workers: runtimeWorkerSettings(plan) });
  return { planFile: join(plan.dataDirectory, "runtime", "plan.json"), composeFile: plan.composeFile };
}

function validateStoredPlan(input: unknown): asserts input is RuntimeDeployment {
  const plan = input as RuntimeDeployment;
  if (!plan || plan.version !== 1 || !["docker", "podman"].includes(plan.engine) || !Array.isArray(plan.workers) || plan.workers.some((worker) => !/^gravity-comfy-(cuda|rocm)-[a-f0-9]{12}$/.test(worker.containerName) || !/^[a-f0-9]{64}$/.test(worker.runtimeRevision) || !/^[a-f0-9]{64}$/.test(worker.deploymentHash))) throw new Error("Invalid saved managed-runtime plan.");
}
export async function readRuntimeDeployment(dataDirectory: string): Promise<RuntimeDeployment> {
  const plan: unknown = JSON.parse(await readFile(join(dataDirectory, "runtime", "plan.json"), "utf8"));
  validateStoredPlan(plan);
  return plan;
}

async function inspectWorker(plan: RuntimeDeployment, worker: ManagedWorker, run: RuntimeRunner) {
  const { stdout } = await run({ program: plan.engine, args: ["container", "inspect", "--format", "{{json .}}", worker.containerName] });
  const container = JSON.parse(stdout);
  if (container.Config?.Labels?.["io.gravity.owner"] !== "gravity-studio" || container.Config?.Labels?.["io.gravity.deployment"] !== worker.deploymentHash || container.Config?.Labels?.["io.gravity.runtime.revision"] !== worker.runtimeRevision) throw new Error(`Existing container ${worker.containerName} differs from the reviewed plan. Drain and recreate it explicitly.`);
  return container;
}

export async function startRuntimeDeployment(plan: RuntimeDeployment, run: RuntimeRunner = executeRuntimeCommand) {
  validateStoredPlan(plan);
  if (plan.diagnostics.some((item) => item.severity === "error")) throw new Error("Resolve the deployment plan's errors before starting workers.");
  await writeRuntimeDeployment(plan);
  for (const command of plan.build) {
    const image = command.args[command.args.indexOf("--tag") + 1];
    const worker = plan.workers.find((item) => item.image === image);
    if (!worker) throw new Error("A build command does not belong to this deployment.");
    const listed = await run({ program: plan.engine, args: ["image", "ls", "--quiet", image] });
    if (listed.stdout.trim()) {
      const inspected = await run({ program: plan.engine, args: ["image", "inspect", "--format", "{{json .}}", image] });
      const existing = JSON.parse(inspected.stdout);
      if (existing.Config?.Labels?.["io.gravity.runtime.revision"] !== worker.runtimeRevision || existing.Config?.Labels?.["io.gravity.runtime.profile"] !== worker.runtimeProfileId) throw new Error(`Image ${image} differs from the reviewed build. Remove or retag it explicitly before rebuilding.`);
    } else await run(command, { timeoutMs: 45 * 60 * 1000, stream: true });
  }
  for (const worker of plan.workers) {
    const listed = await run({ program: plan.engine, args: ["container", "ls", "--all", "--format", "{{.Names}}"] });
    const exists = listed.stdout.split(/\r?\n/).some((name) => name.trim() === worker.containerName);
    if (!exists) await run(worker.create);
    const container = await inspectWorker(plan, worker, run);
    const image = await run({ program: plan.engine, args: ["image", "inspect", "--format", "{{.Id}}", worker.image] });
    if (String(container.Image).replace(/^sha256:/, "") !== image.stdout.trim().replace(/^sha256:/, "")) throw new Error(`Container ${worker.containerName} uses a different built image. Recreate it explicitly after draining jobs.`);
    if (!container.State?.Running) await run(worker.start);
  }
}

const normalizePci = (value: string | null | undefined) => value?.toLowerCase().replace(/^0000([a-f\d]{4}:)/, "$1") ?? null;
export function verifySmokeResult(raw: unknown, worker: ManagedWorker, gpu: GpuDevice, imageId: string): { receipt: Record<string, unknown>; verification: RuntimeVerification | null } {
  const result = raw as { schemaVersion?: number; passed?: boolean; verifiedAt?: string; runtime?: { revision?: string; profileId?: string; comfyCommit?: string }; devices?: { architecture?: string; uuid?: string | null; pciAddress?: string | null }[] };
  if (result.schemaVersion !== 1 || result.passed !== true || !result.verifiedAt || !Number.isFinite(Date.parse(result.verifiedAt)) || result.runtime?.revision !== worker.runtimeRevision || result.runtime?.profileId !== worker.runtimeProfileId || result.runtime?.comfyCommit !== lock.comfyui.commit || result.devices?.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("The GPU smoke test did not verify the expected runtime and immutable image.");
  const device = result.devices[0];
  if (gpu.vendor === "nvidia" ? device.uuid !== gpu.uuid : !gpu.pciAddress || normalizePci(device.pciAddress) !== normalizePci(gpu.pciAddress)) throw new Error("The smoke test executed on a different physical GPU.");
  if (!device.architecture || gpu.architecture && device.architecture !== gpu.architecture) throw new Error("The runtime's GPU architecture differs from the detected device.");
  const profile = lock.profiles[worker.backend];
  if (!(profile.architectures as readonly string[]).includes(device.architecture)) throw new Error("The runtime reported an architecture outside the supported build profile.");
  const verification: RuntimeVerification | null = gpu.architecture && gpu.driverVersion ? {
    gpuId: gpu.id, architecture: device.architecture, driverVersion: gpu.driverVersion, runtimeProfileId: worker.runtimeProfileId, runtimeRevision: worker.runtimeRevision,
    verifiedAt: result.verifiedAt, source: "smoke-test", passed: true,
  } : null;
  return { receipt: { ...result, imageId, gpuId: gpu.id }, verification };
}

export async function smokeRuntimeDeployment(plan: RuntimeDeployment, inventory: HardwareInventory, options: { run?: RuntimeRunner; idle?: (worker: ManagedWorker) => Promise<void> } = {}) {
  const run = options.run ?? executeRuntimeCommand;
  const idle = options.idle ?? (async (worker: ManagedWorker) => {
    const end = Date.now() + 120_000;
    while (true) {
      try {
        const response = await fetch(`${worker.baseUrl}/queue`, { signal: AbortSignal.timeout(3000), redirect: "error" });
        if (!response.ok) throw new Error("Worker is not ready");
        const queue = await response.json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
        if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw new Error("Invalid queue state");
        if (queue.queue_running.length || queue.queue_pending.length) throw new Error("Worker has active or queued jobs; run its smoke test after the queue drains.");
        return;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Worker has")) throw error;
        if (Date.now() >= end) throw new Error("Worker did not become ready for its smoke test within two minutes.");
        await delay(1000);
      }
    }
  });
  const results = [];
  for (const worker of plan.workers) {
    const gpu = inventory.gpus.find((item) => item.id === worker.gpuId);
    if (!gpu) throw new Error("A configured GPU is no longer visible. Regenerate the deployment plan.");
    try {
      const container = await inspectWorker(plan, worker, run);
      if (!container.State?.Running) throw new Error(`Worker ${worker.containerName} is stopped.`);
      await idle(worker);
      const { stdout } = await run({ program: plan.engine, args: ["exec", worker.containerName, "python3", "/opt/gravity/smoke.py"] }, { timeoutMs: 90_000 });
      const raw = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
      const imageId = `sha256:${String(container.Image).replace(/^sha256:/, "")}`;
      results.push(verifySmokeResult(raw, worker, gpu, imageId));
    } catch (error) {
      let message = error instanceof Error ? error.message : "GPU smoke test failed.";
      const output = (error as { stdout?: unknown })?.stdout;
      if (typeof output === "string") {
        try { const failure = JSON.parse(output.trim().split(/\r?\n/).at(-1)!); if (typeof failure.error === "string") message = failure.error.slice(0, 2000); } catch { /* Preserve the bounded command error. */ }
      }
      const verification: RuntimeVerification | null = gpu.architecture && gpu.driverVersion ? { gpuId: gpu.id, architecture: gpu.architecture, driverVersion: gpu.driverVersion,
        runtimeProfileId: worker.runtimeProfileId, runtimeRevision: worker.runtimeRevision, verifiedAt: new Date().toISOString(), source: "smoke-test", passed: false } : null;
      results.push({ receipt: { passed: false, gpuId: gpu.id, error: message }, verification });
      await atomicJson(join(plan.dataDirectory, "runtime", "verification.json"), { version: 1, results });
      throw new Error(message);
    }
  }
  await atomicJson(join(plan.dataDirectory, "runtime", "verification.json"), { version: 1, results });
  return results;
}

export async function stopRuntimeDeployment(plan: RuntimeDeployment, run: RuntimeRunner = executeRuntimeCommand) {
  for (const worker of plan.workers) {
    const container = await inspectWorker(plan, worker, run);
    if (container.State?.Running) {
      const response = await fetch(`${worker.baseUrl}/queue`, { signal: AbortSignal.timeout(3000), redirect: "error" });
      if (!response.ok) throw new Error("Worker queue state could not be confirmed; stop the container explicitly if recovery is needed.");
      const queue = await response.json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
      if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending) || queue.queue_running.length || queue.queue_pending.length) throw new Error("Drain running and queued jobs before stopping a managed worker.");
      await run({ program: plan.engine, args: ["stop", "--time", "30", worker.containerName] }, { timeoutMs: 35_000 });
    }
  }
}
