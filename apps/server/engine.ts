import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ApiError, type GenerationInput, type ModelConfiguration, type WorkerSettings } from "../../packages/contracts/index.ts";
import { detectHardware, checkAdmission, inventoryTelemetry } from "../../packages/hardware/src/index.ts";
import type { HardwareInventory, ResourceLease, ResourceTelemetry } from "../../packages/hardware/src/types.ts";
import { ComfyClient, compileGeneration, checkCapabilities, FAMILY_RECIPES, DEFAULT_MODELS, InferenceError, type ExecutionSnapshot, type ComfyDiscovery, type ComfySystemStats } from "../../packages/inference/index.ts";
import { configuredModel, modelCard, settingsView, validateWorkerUrl } from "./settings.ts";
import { inputBytes, saveOutput } from "./media.ts";
import { Store, publicJob, type PlacementSnapshot, type StoredJob } from "./store.ts";

interface WorkerState {
  connected: boolean;
  checkedAt: number;
  version?: string;
  error?: string;
  discovery?: ComfyDiscovery;
}
const terminal = new Set(["succeeded", "failed", "cancelled"]);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
};
const message = (error: unknown) => error instanceof Error ? error.message : "The worker request failed.";
const hostKey = (worker: WorkerSettings) => worker.location === "local" ? "local" : new URL(worker.baseUrl).hostname;
const deviceKey = (worker: WorkerSettings) => worker.deviceIds[0] ?? `remote:${hostKey(worker)}:unidentified`;
type Admission = { kind: "ready" } | { kind: "wait" | "reject"; reason: string };

export class Engine {
  store: Store;
  hardware: HardwareInventory | null = null;
  hardwareAt = 0;
  workers = new Map<string, WorkerState>();
  clients = new Map<string, ComfyClient>();
  flights = new Map<string, Promise<void>>();
  stopping = false;
  ticking = false;
  timer?: ReturnType<typeof setTimeout>;
  private detect: () => Promise<HardwareInventory>;
  private pollMs: number;
  private reconcileMs: number;
  private started = false;
  private recovery = new Map<string, { attempts: number; nextAt: number }>();
  private releaseAt = new Map<string, number>();
  private idleReleasedFor = new Map<string, string>();
  private loopFlight?: Promise<void>;
  private workerRefresh?: Promise<void>;
  constructor(store: Store, options: { detect?: () => Promise<HardwareInventory>; pollMs?: number; reconcileMs?: number } = {}) {
    this.store = store; this.detect = options.detect ?? detectHardware; this.pollMs = options.pollMs ?? 1500;
    this.reconcileMs = options.reconcileMs ?? Math.max(this.pollMs, 1000);
  }
  client(worker: WorkerSettings) {
    let client = this.clients.get(worker.baseUrl);
    if (!client) { client = new ComfyClient(worker.baseUrl, { timeoutMs: 15_000 }); this.clients.set(worker.baseUrl, client); }
    return client;
  }
  async hardwareReport(force = false) {
    if (!this.hardware || force || Date.now() - this.hardwareAt > 3000) { this.hardware = await this.detect(); this.hardwareAt = Date.now(); }
    return this.hardware;
  }
  async probe(baseUrl: string) {
    const client = new ComfyClient(validateWorkerUrl(baseUrl), { timeoutMs: 8000 });
    const health = await client.health();
    if (!health.healthy) return { connected: false, error: health.error, artifacts: {} };
    try {
      const discovery = await client.discover();
      return { connected: true, version: health.version, artifacts: {
        checkpoint: discovery.models.checkpoints ?? [], diffusion: discovery.models.diffusion_models ?? [],
        "text-encoder": discovery.models.text_encoders ?? [], vae: discovery.models.vae ?? [],
      } };
    } catch (error) { return { connected: false, error: message(error), artifacts: {} }; }
  }
  async refreshWorkers(force = false) {
    if (this.workerRefresh) return this.workerRefresh;
    this.workerRefresh = (async () => {
      await Promise.all(this.store.settings().workers.filter(worker => worker.enabled).map(async worker => {
        const state = this.workers.get(worker.id);
        if (!force && state && Date.now() - state.checkedAt < 20_000) return;
        const client = this.client(worker);
        try {
          const health = await client.health();
          if (!health.healthy) throw new Error(health.error);
          const discovery = await client.discover();
          this.workers.set(worker.id, { connected: true, checkedAt: Date.now(), discovery, version: health.version });
        } catch (error) { this.workers.set(worker.id, { connected: false, checkedAt: Date.now(), error: message(error) }); }
      }));
    })().finally(() => { this.workerRefresh = undefined; });
    return this.workerRefresh;
  }
  invalidateWorkers() { this.workers.clear(); }
  availableWorkers(configuration: ModelConfiguration, snapshot: ExecutionSnapshot): WorkerSettings[] {
    return this.store.settings().workers.filter(worker => {
      const state = this.workers.get(worker.id);
      return worker.enabled && configuration.workerIds.includes(worker.id) && state?.connected && state.discovery && checkCapabilities(snapshot, state.discovery).available;
    });
  }
  async catalog() {
    await this.refreshWorkers();
    const settings = settingsView(this.store);
    const models = DEFAULT_MODELS.map(model => {
      const configuration = settings.modelConfigurations.find(item => item.modelId === model.id)!;
      const resolved = configuredModel(configuration);
      const snapshot = compileGeneration({ modelId: model.id, prompt: "Capability check", seed: 0 }, resolved);
      const available = this.availableWorkers(configuration, snapshot);
      const card = modelCard(resolved, configuration, available.map(worker => worker.id));
      const family = FAMILY_RECIPES[model.familyId];
      return { ...card, unavailableReason: card.missingReasons.join(" "),
        limits: { width: { min: family.dimensions.min, max: family.dimensions.max, step: family.dimensions.multiple, default: card.defaults.width }, height: { min: family.dimensions.min, max: family.dimensions.max, step: family.dimensions.multiple, default: card.defaults.height }, steps: { min: 1, max: 100, default: card.defaults.steps }, cfg: { min: 0, max: 30, default: card.defaults.cfg }, maxImages: family.maxReferences },
        capabilities: { ...card.capabilities, imageInput: family.maxReferences > 0, negativePrompt: model.familyId === "sdxl" },
      };
    });
    return { models, families: Object.values(FAMILY_RECIPES).map(({ id, name }) => ({ id, name })) };
  }
  async submit(userId: string, value: unknown, key: string) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "INVALID_JOB", "Provide generation settings.");
    if (!/^[a-zA-Z0-9_.:-]{8,128}$/.test(key)) throw new ApiError(400, "INVALID_REQUEST_KEY", "Supply an Idempotency-Key between 8 and 128 characters.");
    const allowed = new Set(["modelId", "operation", "prompt", "negativePrompt", "width", "height", "steps", "cfg", "seed", "denoise", "sampler", "scheduler", "images"]);
    if (Object.keys(value).some(field => !allowed.has(field))) throw new ApiError(400, "INVALID_JOB", "The request contains an unsupported generation parameter.");
    const requestHash = createHash("sha256").update(canonical(value)).digest("hex");
    const old = this.store.idempotentJob(userId, key, requestHash);
    if (old) return publicJob(old);
    const input = structuredClone(value) as GenerationInput;
    if (input.images !== undefined && (!Array.isArray(input.images) || input.images.some(id => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)))) throw new ApiError(400, "INVALID_INPUTS", "Choose reference images uploaded to this studio.");
    for (const id of input.images ?? []) this.store.input(id, userId);
    const configuration = settingsView(this.store).modelConfigurations.find(item => item.modelId === input.modelId);
    if (!configuration?.enabled) throw new ApiError(400, "MODEL_DISABLED", "Enable this model in Hardware settings before generating.");
    const model = configuredModel(configuration);
    const operation = input.operation ?? ((input.images?.length ?? 0) ? FAMILY_RECIPES[model.familyId].operations.includes("image-to-image") ? "image-to-image" : "reference" : "text-to-image");
    const snapshot = compileGeneration({ ...input, operation, images: (input.images ?? []).map(id => ({ filename: `${id}.png`, subfolder: "", type: "input" as const })) }, model);
    input.seed = snapshot.parameters.seed; input.operation = operation;
    await this.refreshWorkers();
    const workers = this.availableWorkers(configuration, snapshot);
    if (!workers.length) {
      const issues = this.store.settings().workers.filter(worker => configuration.workerIds.includes(worker.id)).flatMap(worker => {
        const state = this.workers.get(worker.id);
        return state?.discovery ? checkCapabilities(snapshot, state.discovery).issues.map(issue => issue.message) : [state?.error ?? "Worker is not connected."];
      });
      throw new ApiError(409, "MODEL_UNAVAILABLE", issues[0] ?? "Connect a compatible worker with the required model files.");
    }
    const base = model.defaults ?? FAMILY_RECIPES[model.familyId].defaults;
    const pixels = snapshot.parameters.width * snapshot.parameters.height;
    const defaultPixels = (base.width ?? 1024) * (base.height ?? 1024);
    // Until a larger canvas is calibrated, use a conservative growth estimate.
    const scale = Math.max(1, pixels / defaultPixels);
    const memory = { ramBytes: Math.ceil(configuration.memory.ramBytes * scale), vramBytes: Math.ceil(configuration.memory.vramBytes * scale) };
    const placements: PlacementSnapshot[] = workers.map(worker => ({ worker: structuredClone(worker), memory }));
    const job = this.store.createJob(userId, input, snapshot, placements, model.name, { ...snapshot.parameters }, key, requestHash);
    void this.tick();
    return publicJob(job);
  }
  cancel(userId: string, id: string) {
    const job = this.store.job(id, userId);
    if (job.status === "cancelled") return publicJob(job);
    if (job.status !== "queued") throw new ApiError(409, "JOB_ALREADY_STARTED", "Only queued jobs can be cancelled. A running generation will finish and save its result.");
    return publicJob(this.store.patchJob(id, { status: "cancelled", stage: "Cancelled" }));
  }
  async resolve(userId: string, id: string) {
    const job = this.store.job(id, userId);
    if (job.status !== "interrupted") throw new ApiError(409, "JOB_NOT_INTERRUPTED", "Only an interrupted generation can be closed after checking its worker.");
    const placement = job.placements.find(item => item.worker.id === job.workerId);
    if (!placement) throw new ApiError(409, "WORKER_UNKNOWN", "The original worker is unknown. Its generation cannot be safely closed.");
    const client = this.client(placement.worker);
    const snapshot = job.snapshot as ExecutionSnapshot;
    // A legacy prompt ID and the durable UUID can identify the same generation.
    // Both lookups must succeed before absence can release its resource lease.
    const found = await client.findJob(job.id, snapshot.hash);
    const known = job.promptId ? await client.inspect(job.promptId, snapshot) : null;
    const current = this.store.job(id, userId);
    const reported = known && known.state !== "missing" ? known : found;
    if (reported) {
      if (current.status === "interrupted") {
        this.store.patchJob(id, { promptId: reported.promptId });
        this.recovery.delete(id);
        await this.reconcile();
      }
      throw new ApiError(409, "JOB_STILL_REPORTED", "The worker still reports this generation. Gravity will recover its status and result; it cannot be closed.");
    }
    if (current.status !== "interrupted" || current.updatedAt !== job.updatedAt || current.promptId !== job.promptId) throw new ApiError(409, "JOB_STATE_CHANGED", "The generation changed while its worker was checked. Refresh its status before trying again.");
    const closed = this.store.patchJob(id, {
      status: "failed", stage: "Closed by owner", progress: null,
      error: "The owner acknowledged this unknown generation after its worker reported no matching job in queue or history. Its resource reservation was released; it was not submitted again. Later results will not be recovered automatically.",
    });
    this.recovery.delete(id);
    void this.tick();
    return publicJob(closed);
  }
  async state(userId: string) {
    const hardware = await this.hardwareReport();
    return { jobs: this.store.jobs(userId).map(publicJob), hardware, workers: this.store.settings().workers.map(worker => {
      const state = this.workers.get(worker.id);
      const active = this.store.activeJobs().find(job => job.workerId === worker.id && job.status !== "queued");
      return { ...worker, connected: state?.connected ?? false, status: active ? "busy" : state?.connected ? "ready" : "unavailable", error: state?.error, version: state?.version };
    }) };
  }
  private leases(worker: WorkerSettings): ResourceLease[] {
    return this.store.activeJobs().filter(job => job.status !== "queued" && job.workerId).flatMap(job => {
      const placement = job.placements.find(item => item.worker.id === job.workerId);
      if (!placement || hostKey(placement.worker) !== hostKey(worker)) return [];
      return [{ id: job.id, budget: { ramBytes: placement.memory.ramBytes, gpus: { [deviceKey(placement.worker)]: placement.memory.vramBytes } } }];
    });
  }
  private remoteTelemetry(worker: WorkerSettings, stats: ComfySystemStats): ResourceTelemetry | null {
    const { ram_total: totalBytes, ram_free: availableBytes } = stats.system;
    if (totalBytes === undefined || availableBytes === undefined) return null;
    const devices = stats.devices.filter(device => device.type !== "cpu");
    // Standard ComfyUI reports its execution device. If an extension reports
    // several, require an explicit index; never add their VRAM together.
    const id = worker.deviceIds[0];
    const index = id?.match(/^(?:cuda:|hip:|rocm:)?(\d+)$/)?.[1];
    const device = devices.length === 1 ? devices[0] : index === undefined ? undefined : devices.find(item => item.index === Number(index));
    if (device?.vram_total === undefined || device.vram_free === undefined) return null;
    return { sampledAt: stats.sampledAt, ram: { totalBytes, availableBytes }, gpus: { [deviceKey(worker)]: { totalBytes: device.vram_total, availableBytes: device.vram_free } } };
  }
  private async telemetry(worker: WorkerSettings): Promise<ResourceTelemetry | null> {
    return worker.location === "local" ? inventoryTelemetry(await this.hardwareReport(true)) : this.remoteTelemetry(worker, await this.client(worker).systemStats());
  }
  private async admission(placement: PlacementSnapshot): Promise<Admission> {
    const settings = this.store.settings();
    const worker = placement.worker;
    const active = this.store.activeJobs().filter(job => job.status !== "queued" && job.workerId);
    if (active.some(job => job.workerId === worker.id)) return { kind: "wait", reason: "Waiting for this worker's current generation" };
    if (active.length >= settings.policy.maxConcurrentJobs) return { kind: "wait", reason: "Waiting for a free generation slot" };
    const sameHost = active.flatMap(job => job.placements.filter(item => item.worker.id === job.workerId)).filter(item => hostKey(item.worker) === hostKey(worker));
    if (sameHost.some(item => !item.worker.deviceIds.length || !worker.deviceIds.length || deviceKey(item.worker) === deviceKey(worker))) return { kind: "wait", reason: "Waiting for the assigned GPU" };
    try {
      let telemetry = await this.telemetry(worker);
      if (!telemetry) return { kind: "wait", reason: "Waiting for complete memory measurements from the worker" };
      const device = telemetry.gpus[deviceKey(worker)];
      if (Number.isFinite(telemetry.ram.totalBytes) && placement.memory.ramBytes + settings.policy.ramReserveBytes > telemetry.ram.totalBytes) return { kind: "reject", reason: "This job's RAM budget and reserve exceed the worker host's total RAM. Reduce the resolution or change the model budget." };
      if (device && Number.isFinite(device.totalBytes) && placement.memory.vramBytes + settings.policy.vramReserveBytes > device.totalBytes) return { kind: "reject", reason: "This job's VRAM budget and reserve exceed the assigned GPU's capacity. Other GPUs cannot contribute memory to this recipe." };
      const budget = { ramBytes: placement.memory.ramBytes, gpus: { [deviceKey(worker)]: placement.memory.vramBytes } };
      const policy = { reserveRamBytes: settings.policy.ramReserveBytes, reserveVramBytes: settings.policy.vramReserveBytes };
      let result = checkAdmission(budget, telemetry, this.leases(worker), policy);
      if (!result.admitted && ["insufficient-ram", "insufficient-vram"].includes(result.code) && Date.now() - (this.releaseAt.get(worker.baseUrl) ?? 0) >= 30_000) {
        // A previous checkpoint can occupy memory on an otherwise idle worker.
        // Ask that worker to release caches, then measure again. Torch's global
        // free-memory counters are not proof that the studio owns an allocation.
        this.releaseAt.set(worker.baseUrl, Date.now());
        if ((await this.client(worker).freeIfIdle()).released) {
          telemetry = await this.telemetry(worker);
          if (!telemetry) return { kind: "wait", reason: "Waiting for memory measurements after unloading idle models" };
          result = checkAdmission(budget, telemetry, this.leases(worker), policy);
        }
      }
      return result.admitted ? { kind: "ready" } : { kind: result.code === "invalid-budget" ? "reject" : "wait", reason: result.reason };
    } catch (error) { return { kind: "wait", reason: `Waiting for worker memory telemetry: ${message(error)}` }; }
  }
  async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      for (const job of this.store.activeJobs()) {
        if (this.stopping) break;
        if (job.status !== "queued" || this.flights.has(job.id)) continue;
        let reason = "Waiting for an available worker";
        let rejected = 0;
        for (const placement of job.placements) {
          const unchanged = () => {
            const worker = this.store.settings().workers.find(item => item.id === placement.worker.id);
            return worker?.enabled && worker.baseUrl === placement.worker.baseUrl && worker.location === placement.worker.location && canonical(worker.deviceIds) === canonical(placement.worker.deviceIds);
          };
          if (!unchanged()) { reason = "The configured worker changed. Restore it or cancel this queued job."; continue; }
          const decision = await this.admission(placement);
          // Cancellation may arrive while telemetry or cache release is in flight.
          if (this.stopping || this.store.job(job.id).status !== "queued") { reason = ""; break; }
          if (!unchanged()) { reason = "The configured worker changed. Restore it or cancel this queued job."; continue; }
          if (decision.kind !== "ready") { reason = decision.reason; if (decision.kind === "reject") rejected++; continue; }
          this.store.patchJob(job.id, { status: "preparing", workerId: placement.worker.id, stage: "Checking model files", error: null });
          this.launch(job.id, () => this.execute(job.id, placement));
          reason = ""; break;
        }
        if (reason && this.store.job(job.id).status === "queued") {
          if (job.placements.length > 0 && rejected === job.placements.length) this.store.patchJob(job.id, { status: "failed", stage: "Job exceeds the configured workers' capacity", error: reason });
          else if (this.store.job(job.id).stage !== reason) this.store.patchJob(job.id, { stage: reason });
        }
      }
    } finally { this.ticking = false; }
  }
  private launch(id: string, run: () => Promise<void>) {
    const flight = run().catch(error => {
      const job = this.store.job(id);
      if (terminal.has(job.status)) return;
      if (job.submissionStarted) this.interrupted(id, message(error));
      else this.store.patchJob(id, { status: "failed", stage: "Generation could not start", error: message(error), progress: null });
    }).finally(() => { this.flights.delete(id); });
    this.flights.set(id, flight);
  }
  private interrupted(id: string, error: string) {
    const job = this.store.job(id);
    if (terminal.has(job.status)) return;
    const stage = "Connection uncertain; checking the existing generation";
    if (job.status !== "interrupted" || job.error !== error || job.stage !== stage) this.store.patchJob(id, { status: "interrupted", stage, error, progress: null });
    const attempts = (this.recovery.get(id)?.attempts ?? 0) + 1;
    this.recovery.set(id, { attempts, nextAt: Date.now() + Math.min(30_000, this.reconcileMs * 2 ** Math.min(attempts - 1, 10)) });
  }
  private async execute(id: string, placement: PlacementSnapshot) {
    let job = this.store.job(id);
    const client = this.client(placement.worker);
    const discovery = await client.discover();
    let snapshot = job.snapshot as ExecutionSnapshot;
    const capability = checkCapabilities(snapshot, discovery);
    if (!capability.available) throw new ApiError(409, "MODEL_UNAVAILABLE", capability.issues[0].message);
    const inputs = [];
    for (const inputId of job.input.images ?? []) {
      this.store.patchJob(id, { stage: "Uploading reference images" });
      const bytes = await inputBytes(this.store, inputId, job.userId);
      inputs.push(await client.uploadImage(bytes, { filename: `${inputId}.png`, mediaType: "image/png", jobId: id }));
    }
    if (inputs.length) {
      snapshot = compileGeneration({ ...job.input, images: inputs }, snapshot.model);
      this.store.saveExecution(id, snapshot);
    }
    this.store.patchJob(id, { stage: "Submitting workflow", submissionStarted: true });
    try {
      const accepted = await client.submit(snapshot, { jobId: id });
      job = this.store.patchJob(id, { status: "running", promptId: accepted.promptId, stage: "Waiting for ComfyUI" });
    } catch (error) {
      if (error instanceof InferenceError && ["WORKFLOW_REJECTED", "INVALID_WORKFLOW", "CAPABILITY_MISMATCH"].includes(error.code)) {
        this.store.patchJob(id, { status: "failed", stage: "Workflow rejected", error: message(error) }); return;
      }
      throw error;
    }
    await this.observe(job, client, snapshot);
  }
  private async observe(job: StoredJob, client: ComfyClient, snapshot: ExecutionSnapshot) {
    const progress = client.watchProgress(job.id, update => {
      const current = this.store.job(job.id);
      if (current.status !== "running") return;
      if (update.type === "progress") this.store.patchJob(job.id, { progress: null, stage: `Sampling step ${update.value} of ${update.max}${update.node ? ` · ${update.node.slice(0, 80)}` : ""}` });
      else if (update.type === "executing") this.store.patchJob(job.id, { progress: null, stage: "Executing workflow" });
    });
    try {
      while (!this.stopping) {
        const result = await client.inspect(job.promptId!, snapshot);
        if (terminal.has(this.store.job(job.id).status)) return;
        if (result.state === "succeeded") {
          this.store.patchJob(job.id, { stage: "Saving images", progress: null });
          const outputs = [];
          for (const [index, reference] of result.outputs.entries()) {
            try {
              const output = await client.fetchOutput(job.promptId!, reference, snapshot);
              if (terminal.has(this.store.job(job.id).status)) return;
              outputs.push(await saveOutput(this.store, job.id, index, output.bytes));
            }
            catch (error) {
              const invalid = error instanceof ApiError && error.code === "INVALID_OUTPUT" || error instanceof InferenceError && ["INVALID_OUTPUT", "RESPONSE_TOO_LARGE"].includes(error.code);
              if (!invalid) throw error;
              this.store.patchJob(job.id, { status: "failed", stage: "Worker returned an invalid image", progress: null, error: error.message });
              this.recovery.delete(job.id);
              return;
            }
          }
          if (!outputs.length) throw new Error("The workflow completed without an image output.");
          this.store.patchJob(job.id, { status: "succeeded", stage: "Completed", progress: null, outputs, error: null });
          this.recovery.delete(job.id);
          return;
        }
        if (result.state === "failed") { this.store.patchJob(job.id, { status: "failed", stage: "Generation failed", progress: null, error: result.error ?? "ComfyUI could not complete this workflow." }); this.recovery.delete(job.id); return; }
        if (result.state === "missing") throw new Error("The accepted job is missing from the worker. It will not be submitted again automatically.");
        await delay(this.pollMs);
      }
    } finally { progress.close(); }
  }
  async reconcile() {
    for (const job of this.store.activeJobs()) {
      if (job.status === "queued" || this.flights.has(job.id) || this.stopping || Date.now() < (this.recovery.get(job.id)?.nextAt ?? 0)) continue;
      const placement = job.placements.find(item => item.worker.id === job.workerId);
      if (!placement) continue;
      if (!job.submissionStarted) {
        this.store.patchJob(job.id, { status: "failed", stage: "Interrupted before submission", error: "The server stopped before this job was sent. Create a new generation to try again." }); continue;
      }
      this.launch(job.id, async () => {
        const client = this.client(placement.worker);
        const found = job.promptId ? await client.inspect(job.promptId, job.snapshot as ExecutionSnapshot) : await client.findJob(job.id, (job.snapshot as ExecutionSnapshot).hash);
        if (this.stopping || terminal.has(this.store.job(job.id).status)) return;
        if (!found || found.state === "missing") {
          this.interrupted(job.id, "The worker does not report this job. It will not be submitted again automatically.");
          return;
        }
        const resumed = this.store.patchJob(job.id, { status: "running", promptId: found.promptId, stage: "Reconnected to worker", error: null });
        await this.observe(resumed, client, resumed.snapshot as ExecutionSnapshot);
      });
    }
  }
  private async unloadIdleWorkers() {
    if (this.stopping) return;
    const settings = this.store.settings();
    if (!settings.policy.idleUnloadSeconds) return;
    const jobs = this.store.jobs();
    for (const worker of settings.workers.filter(item => item.enabled)) {
      if (this.stopping) return;
      const assigned = jobs.filter(job => job.workerId === worker.id && job.placements.some(placement => placement.worker.id === worker.id && placement.worker.baseUrl === worker.baseUrl));
      if (!assigned.length || assigned.some(job => !terminal.has(job.status))) continue;
      const lastUsed = assigned.map(job => job.updatedAt).sort().at(-1)!;
      if (Date.now() - Date.parse(lastUsed) < settings.policy.idleUnloadSeconds * 1000 || this.idleReleasedFor.get(worker.baseUrl) === lastUsed || Date.now() - (this.releaseAt.get(worker.baseUrl) ?? 0) < 30_000) continue;
      this.releaseAt.set(worker.baseUrl, Date.now());
      try {
        if ((await this.client(worker).freeIfIdle()).released) this.idleReleasedFor.set(worker.baseUrl, lastUsed);
      } catch { /* Keep idle release separate from job state; retry after cooldown. */ }
    }
  }
  async start() {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    await this.hardwareReport();
    await this.reconcile();
    const loop = () => {
      this.loopFlight = (async () => {
        try {
          await this.reconcile();
          if (this.stopping) return;
          await this.refreshWorkers(); await this.tick(); await this.unloadIdleWorkers();
        } catch (error) { console.error("Generation scheduler:", message(error)); }
      })().finally(() => {
        this.loopFlight = undefined;
        if (!this.stopping) this.timer = setTimeout(loop, this.pollMs);
      });
    };
    loop();
  }
  async stop() {
    this.stopping = true; clearTimeout(this.timer);
    await this.loopFlight;
    while (this.ticking) await delay(10);
    await Promise.allSettled(this.flights.values());
    this.started = false;
  }
}
