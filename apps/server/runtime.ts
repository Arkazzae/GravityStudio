import { ApiError } from "../../packages/contracts/index.ts";
import { prepareAutomaticRuntime } from "../../scripts/runtime-auto.ts";
import { executeRuntimeCommand, readRuntimeDeployment, startRuntimeDeployment, smokeRuntimeDeployment, writeRuntimeDeployment, type RuntimeRunner } from "../../scripts/runtime-control.ts";
import { runtimeWorkerSettings, type RuntimeDeployment } from "../../scripts/runtime-plan.ts";
import { settingsView, validateSettings } from "./settings.ts";
import type { Engine } from "./engine.ts";
import type { Store } from "./store.ts";

export interface RuntimeSetupStatus {
  phase: "idle" | "checking" | "building" | "testing" | "connecting" | "ready" | "failed";
  busy: boolean;
  message: string;
  error: string | null;
  engine: "docker" | "podman" | null;
  workerCount: number;
  updatedAt: string | null;
}
interface Dependencies {
  prepare: typeof prepareAutomaticRuntime;
  read: typeof readRuntimeDeployment;
  write: typeof writeRuntimeDeployment;
  start: typeof startRuntimeDeployment;
  smoke: typeof smokeRuntimeDeployment;
  run: RuntimeRunner;
}
const defaults: Dependencies = { prepare: prepareAutomaticRuntime, read: readRuntimeDeployment, write: writeRuntimeDeployment, start: startRuntimeDeployment, smoke: smokeRuntimeDeployment, run: executeRuntimeCommand };

/** An owner-triggered operation. HTTP requests never supply shell commands or host paths. */
export class RuntimeSetup {
  private state: RuntimeSetupStatus;
  private flight?: Promise<void>;
  private abort = new AbortController();
  private closed = false;
  private dependencies: Dependencies;
  private store: Store;
  private engine: Engine;
  constructor(store: Store, engine: Engine, dependencies: Partial<Dependencies> = {}) {
    this.store = store; this.engine = engine; this.dependencies = { ...defaults, ...dependencies };
    this.state = store.metadata<RuntimeSetupStatus>("runtime-setup") ?? { phase: "idle", busy: false, message: "Choose the GPUs to use for image generation.", error: null, engine: null, workerCount: 0, updatedAt: null };
    if (this.state.busy) this.update({ phase: "failed", busy: false, message: "Setup was interrupted by a server restart. Try again to continue.", error: "The saved runtime and downloaded layers will be reused." });
  }
  status() { return structuredClone(this.state); }
  private update(change: Partial<RuntimeSetupStatus>) {
    this.state = { ...this.state, ...change, updatedAt: new Date().toISOString() };
    this.store.setMetadata("runtime-setup", this.state);
  }
  start(body: Record<string, unknown>) {
    if (Object.keys(body).some(key => key !== "gpuIds") || !Array.isArray(body.gpuIds) || !body.gpuIds.length || body.gpuIds.length > 64 || body.gpuIds.some(id => typeof id !== "string" || !id.length || id.length > 200) || new Set(body.gpuIds).size !== body.gpuIds.length) throw new ApiError(400, "INVALID_GPU_SELECTION", "Choose at least one detected GPU, without duplicates.");
    if (this.closed) throw new ApiError(503, "SERVER_STOPPING", "The studio server is shutting down.");
    if (this.flight) throw new ApiError(409, "RUNTIME_BUSY", "Image generation setup is already running.");
    this.engine.beginRuntimeSetup();
    this.abort = new AbortController();
    this.update({ phase: "checking", busy: true, message: "Checking your GPUs and available container engine…", error: null });
    this.flight = this.perform(body.gpuIds as string[]).catch(error => {
      this.update({ phase: "failed", busy: false, message: "Image generation setup could not finish.", error: (error instanceof Error ? error.message : "Runtime setup failed.").slice(0, 4000) });
    }).finally(() => { this.engine.endRuntimeSetup(); this.flight = undefined; });
    return this.status();
  }
  private async perform(gpuIds: string[]) {
    const hardware = await this.engine.hardwareReport(true);
    if (gpuIds.some(id => !hardware.gpus.some(gpu => gpu.id === id))) throw new Error("A selected GPU is no longer available. Refresh hardware and choose again.");
    let saved: RuntimeDeployment | undefined;
    try { saved = await this.dependencies.read(this.store.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const { plan, preflight } = await this.dependencies.prepare(hardware, this.store.directory, { gpuIds, expandSaved: !!saved });
    const errors = [...preflight.checks.filter(check => check.status === "failed").map(check => check.message), ...plan.diagnostics.filter(item => item.severity === "error").map(item => item.message)];
    if (!preflight.ready || errors.length) throw new Error(errors.join(" ") || "Runtime prerequisites are not ready.");
    const selected = plan.workers.filter(worker => gpuIds.includes(worker.gpuId));
    if (selected.length !== gpuIds.length) throw new Error("The runtime could not place every selected GPU.");
    // Keep the full deployment inventory so unselected workers retain their ports and identities.
    const active: RuntimeDeployment = { ...plan, workers: selected, build: plan.build.filter(command => selected.some(worker => command.args.includes(worker.image))) };
    this.abort.signal.throwIfAborted();
    this.update({ phase: "building", engine: plan.engine, workerCount: selected.length, message: "Preparing image generation. The first download can take several minutes…" });
    await this.dependencies.write(plan);
    const run: RuntimeRunner = (command, options) => this.dependencies.run(command, { ...options, signal: this.abort.signal });
    await this.dependencies.start(active, run, { writePlan: false });
    this.abort.signal.throwIfAborted();
    this.update({ phase: "testing", message: "Testing image generation on the selected GPUs…" });
    await this.dependencies.smoke(active, hardware, { run, signal: this.abort.signal });
    this.abort.signal.throwIfAborted();
    this.update({ phase: "connecting", message: "Connecting your GPUs to the studio…" });
    const settings = settingsView(this.store);
    const automaticConcurrency = this.store.metadata<boolean>("runtime-auto-concurrency") ?? (!settings.workers.length || settings.policy.maxConcurrentJobs === settings.workers.filter(worker => worker.enabled).length);
    const managedIds = new Set(plan.workers.map(worker => worker.id));
    const enabledIds = new Set(selected.map(worker => worker.id));
    const managed = runtimeWorkerSettings(plan).map(worker => ({ ...worker, enabled: enabledIds.has(worker.id) }));
    const aliases = new Map<string, string>();
    const existing = settings.workers.filter(worker => {
      const managedWorker = managed.find(item => item.baseUrl === worker.baseUrl);
      if (managedWorker) { aliases.set(worker.id, managedWorker.id); return false; }
      return !managedIds.has(worker.id);
    });
    settings.workers = [...existing.map(worker => worker.location === "local" && !worker.deviceIds.some(id => gpuIds.includes(id)) ? { ...worker, enabled: false } : worker), ...managed];
    for (const model of settings.modelConfigurations) {
      const assigned = model.workerIds.map(id => aliases.get(id) ?? id);
      model.workerIds = [...new Set(assigned.some(id => managedIds.has(id)) ? [...assigned.filter(id => !managedIds.has(id)), ...enabledIds] : assigned)];
    }
    if (automaticConcurrency) settings.policy.maxConcurrentJobs = settings.workers.filter(worker => worker.enabled).length;
    if (settings.revision === 0) settings.policy.idleUnloadSeconds = 120;
    // settingsView only returns registered models; validateSettings receives their manifests below.
    const { modelRegistry } = await import("./registry.ts");
    this.store.saveSettings(validateSettings(settings, hardware, modelRegistry(this.store)));
    this.store.setMetadata("runtime-auto-concurrency", automaticConcurrency);
    this.engine.invalidateWorkers();
    await this.engine.refreshWorkers(true);
    const disconnected = selected.find(worker => !this.engine.workers.get(worker.id)?.connected);
    if (disconnected) throw new Error("A GPU worker did not connect after its test. Retry setup to reconnect it.");
    this.update({ phase: "ready", busy: false, message: "Your GPUs are ready. Choose or download a model in Models.", error: null });
  }
  async close() { this.closed = true; this.abort.abort(); await this.flight; }
}
