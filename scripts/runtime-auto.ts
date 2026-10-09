import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { assessRuntimeCompatibility } from "../packages/hardware/src/index.ts";
import type { HardwareInventory } from "../packages/hardware/src/index.ts";
import { inspectRuntimePrerequisites, selectRuntimeEngine } from "./doctor.ts";
import type { ContainerEngineChoice, PreflightCheck, RuntimePreflight } from "./doctor.ts";
import { executeRuntimeCommand, readRuntimeDeployment } from "./runtime-control.ts";
import { createRuntimeDeployment, managedRuntimeProfiles } from "./runtime-plan.ts";
import type { ManagedWorker, RuntimeDeployment } from "./runtime-plan.ts";

export interface AutomaticRuntimeOptions {
  engine?: ContainerEngineChoice;
  gpuIds?: string[];
  portBase?: number;
  /** Add newly selected GPUs while retaining every existing worker and endpoint. */
  expandSaved?: boolean;
}
export interface AutomaticRuntimeDependencies {
  readPlan(dataDirectory: string): Promise<RuntimeDeployment | null>;
  inspectPrerequisites: typeof inspectRuntimePrerequisites;
  portAvailable(port: number): Promise<boolean>;
  portOwnedByWorker(plan: RuntimeDeployment, worker: ManagedWorker): Promise<boolean>;
}

/** An availability check only: container creation still arbitrates concurrent binds. */
export function runtimePortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else reject(error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close((error) => error ? reject(error) : resolve(true)));
  });
}

const defaultDependencies: AutomaticRuntimeDependencies = {
  async readPlan(dataDirectory) {
    try { return await readRuntimeDeployment(dataDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  },
  inspectPrerequisites: inspectRuntimePrerequisites,
  portAvailable: runtimePortAvailable,
  async portOwnedByWorker(plan, worker) {
    try {
      const { stdout } = await executeRuntimeCommand({ program: plan.engine, args: ["container", "inspect", "--format", "{{json .}}", worker.containerName] }, { timeoutMs: 5000 });
      const container = JSON.parse(stdout);
      const labels = container.Config?.Labels;
      if (container.State?.Running !== true || labels?.["io.gravity.owner"] !== "gravity-studio" || labels?.["io.gravity.deployment"] !== worker.deploymentHash || labels?.["io.gravity.runtime.revision"] !== worker.runtimeRevision) return false;
      const bindings = container.NetworkSettings?.Ports?.["8188/tcp"];
      return Array.isArray(bindings) && bindings.some((binding: { HostIp?: string; HostPort?: string }) => binding.HostIp === "127.0.0.1" && binding.HostPort === new URL(worker.baseUrl).port);
    } catch { return false; }
  },
};

function addChecks(preflight: RuntimePreflight, checks: PreflightCheck[]): RuntimePreflight {
  const combined = [...preflight.checks, ...checks];
  return { ...preflight, checks: combined, ready: combined.every((check) => check.status !== "failed") };
}

function planChecks(plan: RuntimeDeployment): PreflightCheck[] {
  return plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => ({ id: `plan:${diagnostic.code}`, status: "failed", message: diagnostic.message }));
}

function savedPlanChecks(plan: RuntimeDeployment, inventory: HardwareInventory, dataDirectory: string, options: AutomaticRuntimeOptions): PreflightCheck[] {
  const checks: PreflightCheck[] = [], fail = (id: string, message: string) => checks.push({ id, status: "failed", message });
  if (plan.dataDirectory !== dataDirectory || plan.modelsDirectory !== join(dataDirectory, "models") || plan.composeFile !== join(dataDirectory, "runtime", "compose.json")) fail("saved-paths", "The saved deployment belongs to another data directory. Restore the original paths before starting it.");
  if (options.engine && options.engine !== "auto" && options.engine !== plan.engine) fail("saved-engine", `This deployment uses ${plan.engine}. Automatic startup preserves its engine; an engine migration must be performed explicitly.`);
  const ids = plan.workers.map((worker) => worker.gpuId);
  if (!ids.length || new Set(ids).size !== ids.length) fail("saved-gpus", "The saved deployment must contain one worker per selected GPU.");
  if (options.gpuIds && (!options.gpuIds.length || new Set(options.gpuIds).size !== options.gpuIds.length)) fail("saved-selection", "Select at least one GPU, without duplicates.");
  if (!options.expandSaved && options.gpuIds && (options.gpuIds.length !== ids.length || !options.gpuIds.every((id) => ids.includes(id)))) fail("saved-selection", "The requested GPU selection differs from the saved deployment. Automatic startup preserves its workers; change the deployment explicitly before selecting different GPUs.");
  const profiles = managedRuntimeProfiles(), ports: number[] = [];
  for (const [index, worker] of plan.workers.entries()) {
    const gpu = inventory.gpus.find((item) => item.id === worker.gpuId);
    const profile = profiles.find((item) => item.id === worker.runtimeProfileId && item.backend === worker.backend);
    const selected = !options.expandSaved || !options.gpuIds || options.gpuIds.includes(worker.gpuId);
    if (selected && !gpu) fail(`saved-gpu:${worker.id}`, `The saved GPU ${worker.gpuId} is no longer visible. Restore its visibility before starting this deployment.`);
    else if (selected && gpu && (!profile || profile.revision !== worker.runtimeRevision || assessRuntimeCompatibility(gpu, profile).status === "incompatible")) fail(`saved-runtime:${worker.id}`, `The saved runtime for ${worker.gpuId} does not match this checkout or its hardware. Review a runtime migration before replacing existing workers.`);
    let port: number | null = null;
    try {
      const url = new URL(worker.baseUrl);
      if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash) port = Number(url.port);
    } catch { /* Report a blocking diagnostic without trying to bind an invalid endpoint. */ }
    if (port === null || !Number.isInteger(port) || port < 1024 || port > 65535 || ports.includes(port)) fail(`saved-port:${worker.id}`, "The saved deployment contains an invalid or repeated loopback worker port.");
    else {
      ports.push(port);
      if (options.portBase !== undefined && port !== options.portBase + index) fail(`saved-port-selection:${worker.id}`, "The requested ports differ from the saved deployment. Automatic startup preserves its existing endpoints.");
    }
  }
  return [...checks, ...planChecks(plan)];
}

async function findPortRange(count: number, start: number, available: AutomaticRuntimeDependencies["portAvailable"]): Promise<number | null> {
  let beginning = start, length = 0;
  for (let port = start; port <= 65535; port++) {
    if (await available(port)) { if (++length === count) return beginning; }
    else { beginning = port + 1; length = 0; }
  }
  return null;
}

/** Read-only selection. Nothing is saved, built or started until its caller requests startup. */
export async function prepareAutomaticRuntime(inventory: HardwareInventory, dataDirectory: string, options: AutomaticRuntimeOptions = {}, dependencies: Partial<AutomaticRuntimeDependencies> = {}): Promise<{ plan: RuntimeDeployment; preflight: RuntimePreflight }> {
  const probe = { ...defaultDependencies, ...dependencies }, directory = resolve(dataDirectory);
  const saved = await probe.readPlan(directory);
  if (saved) {
    const requested = options.expandSaved && options.gpuIds ? options.gpuIds : saved.workers.map((worker) => worker.gpuId);
    const selected = { ...inventory, gpus: inventory.gpus.filter((gpu) => requested.includes(gpu.id)) };
    let preflight = addChecks(await probe.inspectPrerequisites(selected, saved.engine), savedPlanChecks(saved, inventory, directory, options));
    if (preflight.ready) {
      const checks = await Promise.all(saved.workers.filter((worker) => requested.includes(worker.gpuId)).map(async (worker): Promise<PreflightCheck> => {
        const available = await probe.portAvailable(Number(new URL(worker.baseUrl).port)) || await probe.portOwnedByWorker(saved, worker);
        return { id: `worker-port:${worker.id}`, status: available ? "passed" : "failed", message: available ? `${worker.baseUrl} is available or belongs to its saved worker.` : `${worker.baseUrl} is occupied by another process. Free the saved port before starting this worker.` };
      }));
      preflight = addChecks(preflight, checks);
    }
    const addedIds = options.expandSaved ? requested.filter((id) => !saved.workers.some((worker) => worker.gpuId === id)) : [];
    if (preflight.ready && addedIds.length) {
      let addition = createRuntimeDeployment(inventory, { dataDirectory: directory, engine: saved.engine, gpuIds: addedIds, supplementalGroupIds: preflight.supplementalGroupIds });
      preflight = addChecks(preflight, planChecks(addition));
      if (!preflight.ready) return { plan: saved, preflight };
      const reserved = new Set(saved.workers.map((worker) => Number(new URL(worker.baseUrl).port)));
      const portBase = await findPortRange(addition.workers.length, 8188, async (port) => !reserved.has(port) && await probe.portAvailable(port));
      if (portBase === null) return { plan: saved, preflight: addChecks(preflight, [{ id: "worker-ports", status: "failed", message: "No consecutive free loopback ports were found for the additional GPUs." }]) };
      addition = createRuntimeDeployment(inventory, { dataDirectory: directory, engine: saved.engine, gpuIds: addedIds, portBase, supplementalGroupIds: preflight.supplementalGroupIds });
      const images = new Set(saved.workers.map((worker) => worker.image));
      const plan: RuntimeDeployment = { ...saved,
        workers: [...saved.workers, ...addition.workers],
        build: [...saved.build, ...addition.build.filter((command) => !images.has(command.args[command.args.indexOf("--tag") + 1]))],
        compose: { ...saved.compose, services: { ...saved.compose.services, ...addition.compose.services } },
        diagnostics: [...saved.diagnostics, ...addition.diagnostics],
      };
      return { plan, preflight: addChecks(preflight, [{ id: "additional-worker-ports", status: "passed", message: `Selected free loopback ports ${portBase}–${portBase + addition.workers.length - 1} for additional GPUs; existing endpoints are preserved.` }]) };
    }
    return { plan: saved, preflight };
  }
  const selected = { ...inventory, gpus: options.gpuIds ? inventory.gpus.filter((gpu) => options.gpuIds!.includes(gpu.id)) : inventory.gpus };
  const { engine, preflight: enginePreflight } = await selectRuntimeEngine(selected, options.engine, probe.inspectPrerequisites);
  let plan = createRuntimeDeployment(inventory, { dataDirectory: directory, engine, gpuIds: options.gpuIds, portBase: options.portBase, supplementalGroupIds: enginePreflight.supplementalGroupIds });
  let preflight = addChecks(enginePreflight, planChecks(plan));
  if (!preflight.ready) return { plan, preflight };
  if (options.portBase === undefined) {
    const portBase = await findPortRange(plan.workers.length, 8188, probe.portAvailable);
    if (portBase === null) preflight = addChecks(preflight, [{ id: "worker-ports", status: "failed", message: "No consecutive free loopback ports were found for the selected GPUs." }]);
    else {
      plan = createRuntimeDeployment(inventory, { dataDirectory: directory, engine, gpuIds: options.gpuIds, portBase, supplementalGroupIds: preflight.supplementalGroupIds });
      preflight = addChecks(preflight, [{ id: "worker-ports", status: "passed", message: `Selected free loopback ports ${portBase}–${portBase + plan.workers.length - 1}.` }]);
    }
  } else {
    const available = await Promise.all(plan.workers.map((worker) => probe.portAvailable(Number(new URL(worker.baseUrl).port))));
    preflight = addChecks(preflight, [{ id: "worker-ports", status: available.every(Boolean) ? "passed" : "failed", message: available.every(Boolean) ? "The requested loopback worker ports are available." : "A requested worker port is occupied. Choose another port range or let automatic setup select one." }]);
  }
  return { plan, preflight };
}
