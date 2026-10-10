import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ApiError, type GenerationInput, type ModelConfiguration, type WorkerSettings } from "../../packages/contracts/index.ts";
import { detectHardware, checkAdmission, inventoryTelemetry } from "../../packages/hardware/src/index.ts";
import type { HardwareInventory, ResourceLease, ResourceTelemetry } from "../../packages/hardware/src/types.ts";
import { ComfyClient, compileGeneration, checkCapabilities, FAMILY_RECIPES, InferenceError, isRelativeFile, type ExecutionSnapshot, type ComfyDiscovery, type ComfySystemStats, type ModelArtifact } from "../../packages/inference/index.ts";
import { configuredModel, modelCard, settingsView, validateWorkerUrl } from "./settings.ts";
import { inputBytes, saveOutput } from "./media.ts";
import { Store, publicJob, type PlacementSnapshot, type StoredJob } from "./store.ts";
import { modelRegistry } from "./registry.ts";
import { BIREFNET_MEMORY } from "../../packages/inference/index.ts";

interface WorkerState {
  connected: boolean;
  checkedAt: number;
  version?: string;
  error?: string;
  /** Retained offline for installed-file display; scheduling still requires connected. */
  discovery?: ComfyDiscovery;
  identity?: string;
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
const workersOverlap = (a: WorkerSettings, b: WorkerSettings) => a.id === b.id || a.baseUrl === b.baseUrl || (hostKey(a) === hostKey(b) && (!a.deviceIds.length || !b.deviceIds.length || deviceKey(a) === deviceKey(b)));
const workerIdentity = (worker: WorkerSettings) => canonical({ id: worker.id, baseUrl: worker.baseUrl, location: worker.location, deviceIds: worker.deviceIds });
const modelIdentity = (snapshot: ExecutionSnapshot) => canonical({
  recipe: { familyId: snapshot.recipe.familyId, revision: snapshot.recipe.revision },
  model: { familyId: snapshot.model.familyId, revision: snapshot.model.revision, artifacts: [...snapshot.model.artifacts].sort((a, b) => a.role.localeCompare(b.role)) },
});
type Admission = { kind: "ready" } | { kind: "wait" | "reject"; reason: string; reclaimable?: boolean; ramPressure?: boolean };

async function localArtifactsInstalled(directory: string, artifacts: ModelArtifact[]): Promise<boolean> {
  return (await Promise.all(artifacts.map(async artifact => {
    if (!isRelativeFile(artifact.filename)) return false;
    try { const file = await lstat(join(directory, "models", artifact.folder, artifact.filename)); return file.isFile() && !file.isSymbolicLink() && file.size > 0; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }))).every(Boolean);
}

export class Engine {
  store: Store;
  hardware: HardwareInventory | null = null;
  hardwareAt = 0;
  workers = new Map<string, WorkerState>();
  clients = new Map<string, ComfyClient>();
  flights = new Map<string, Promise<void>>();
  stopping = false;
  runtimeSetupActive = false;
  ticking = false;
  timer?: ReturnType<typeof setTimeout>;
  private detect: () => Promise<HardwareInventory>;
  private pollMs: number;
  private reconcileMs: number;
  private started = false;
  private recovery = new Map<string, { attempts: number; nextAt: number }>();
  private releaseAt = new Map<string, number>();
  private idleReleasedFor = new Map<string, string>();
  // A routing preference, never evidence of resident memory or a lease credit.
  private warmWorkers = new Map<string, { worker: string; model: string }>();
  private releasingWorkers = new Map<string, { worker: WorkerSettings; until: number }>();
  private memoryReleaseAt = new Map<string, number>();
  private tickReleasedHosts = new Set<string>();
  private loopFlight?: Promise<void>;
  private workerRefresh?: Promise<void>;
  private workerRevision = 0;
  private workerRefreshRevision = 0;
  private textLeases = new Map<string, ResourceLease>();
  private textLeaseRevision = 0;
  private evictText?: () => Promise<boolean>;
  setTextEviction(evict: () => Promise<boolean>) { this.evictText = evict; }
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
        checkpoint: discovery.models.checkpoints ?? [], diffusion: discovery.models.diffusion_models ?? [], "diffusion-unconditional": discovery.models.diffusion_models ?? [],
        "text-encoder": discovery.models.text_encoders ?? [], vae: discovery.models.vae ?? [],
      } };
    } catch (error) { return { connected: false, error: message(error), artifacts: {} }; }
  }
  async refreshWorkers(force = false): Promise<void> {
    if (this.workerRefresh) {
      const revision = this.workerRefreshRevision;
      await this.workerRefresh;
      if (revision !== this.workerRevision) return this.refreshWorkers(force);
      return;
    }
    const revision = this.workerRevision;
    this.workerRefreshRevision = revision;
    this.workerRefresh = (async () => {
      await Promise.all(this.store.settings().workers.filter(worker => worker.enabled).map(async worker => {
        const identity = workerIdentity(worker);
        const warm = this.warmWorkers.get(worker.id);
        if (warm && warm.worker !== identity) this.warmWorkers.delete(worker.id);
        const state = this.workers.get(worker.id);
        if (!force && state?.identity === identity && Date.now() - state.checkedAt < 20_000) return;
        const client = this.client(worker);
        try {
          const health = await client.health();
          if (!health.healthy) throw new Error(health.error);
          const discovery = await client.discover();
          if (revision === this.workerRevision) this.workers.set(worker.id, { connected: true, checkedAt: Date.now(), discovery, version: health.version, identity });
        } catch (error) { if (revision === this.workerRevision) { this.warmWorkers.delete(worker.id); this.workers.set(worker.id, { connected: false, checkedAt: Date.now(), error: message(error), identity, ...(state?.identity === identity && state.discovery ? { discovery: state.discovery } : {}) }); } }
      }));
    })().finally(() => { this.workerRefresh = undefined; });
    return this.workerRefresh;
  }
  invalidateWorkers() {
    this.workerRevision++;
    const identities = new Map(this.store.settings().workers.map(worker => [worker.id, workerIdentity(worker)]));
    for (const [id, state] of this.workers) {
      if (state.identity && state.discovery && identities.get(id) === state.identity) this.workers.set(id, { connected: false, checkedAt: 0, identity: state.identity, discovery: state.discovery });
      else this.workers.delete(id);
    }
    this.warmWorkers.clear();
  }
  beginRuntimeSetup() {
    if (this.runtimeSetupActive) throw new ApiError(409, "RUNTIME_BUSY", "Image generation setup is already running.");
    if (this.store.activeJobs().length || this.flights.size) throw new ApiError(409, "JOBS_ACTIVE", "Finish or cancel queued generations before changing the GPUs in use.");
    if (this.textLeases.size) throw new ApiError(409, "TEXT_GPU_BUSY", "Wait for the local prompt assistant to release its GPU before changing GPU setup.");
    this.runtimeSetupActive = true;
  }
  endRuntimeSetup() { this.runtimeSetupActive = false; }
  availableWorkers(configuration: ModelConfiguration, snapshot: ExecutionSnapshot): WorkerSettings[] {
    return this.store.settings().workers.filter(worker => {
      const state = this.workers.get(worker.id);
      return worker.enabled && configuration.workerIds.includes(worker.id) && state?.connected && state.discovery && checkCapabilities(snapshot, state.discovery).available;
    });
  }
  async catalog() {
    await this.refreshWorkers();
    const settings = settingsView(this.store);
    const models = await Promise.all(modelRegistry(this.store).map(async model => {
      const configuration = settings.modelConfigurations.find(item => item.modelId === model.id)!;
      const resolved = configuredModel(configuration, this.store);
      const snapshot = compileGeneration({ modelId: model.id, prompt: "Capability check", seed: 0 }, resolved);
      const available = this.availableWorkers(configuration, snapshot);
      const card = modelCard(resolved, configuration, available.map(worker => worker.id));
      const family = FAMILY_RECIPES[model.familyId];
      const transparent = compileGeneration({ modelId: model.id, prompt: "Capability check", seed: 0, background: "transparent" }, resolved);
      const transparentWorkers = this.availableWorkers(configuration, transparent);
      const background = { native: !!family.nativeTransparency, available: transparentWorkers.length > 0,
        ...(!transparentWorkers.length ? { reason: !available.length ? "Connect a ready worker for this model." : "Download BiRefNet in Models and use a worker with background removal support." } : {}) };
      const installed = await localArtifactsInstalled(this.store.directory, resolved.artifacts) || settings.workers.some(worker => {
        const state = this.workers.get(worker.id);
        return state?.identity === workerIdentity(worker) && !!state.discovery && resolved.artifacts.every(artifact => state.discovery!.models[artifact.folder]?.includes(artifact.filename));
      });
      return { ...card, installed, unavailableReason: card.missingReasons.join(" "),
        limits: { width: { min: family.dimensions.min, max: family.dimensions.max, step: family.dimensions.multiple, default: card.defaults.width }, height: { min: family.dimensions.min, max: family.dimensions.max, step: family.dimensions.multiple, default: card.defaults.height }, steps: { min: 1, max: 100, default: card.defaults.steps }, cfg: { min: 0, max: 30, default: card.defaults.cfg }, maxImages: family.maxReferences },
        capabilities: { ...card.capabilities, imageInput: family.maxReferences > 0, negativePrompt: model.familyId === "sdxl" || model.familyId === "qwen-image-2.1", background },
      };
    }));
    return { models, families: Object.values(FAMILY_RECIPES).map(({ id, name }) => ({ id, name })) };
  }
  async submit(userId: string, value: unknown, key: string) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "INVALID_JOB", "Provide generation settings.");
    if (!/^[a-zA-Z0-9_.:-]{8,128}$/.test(key)) throw new ApiError(400, "INVALID_REQUEST_KEY", "Supply an Idempotency-Key between 8 and 128 characters.");
    const allowed = new Set(["modelId", "operation", "prompt", "negativePrompt", "width", "height", "steps", "cfg", "seed", "denoise", "sampler", "scheduler", "images", "background"]);
    if (Object.keys(value).some(field => !allowed.has(field))) throw new ApiError(400, "INVALID_JOB", "The request contains an unsupported generation parameter.");
    const requestHash = createHash("sha256").update(canonical(value)).digest("hex");
    const old = this.store.idempotentJob(userId, key, requestHash);
    if (old) return publicJob(old);
    if (this.runtimeSetupActive) throw new ApiError(409, "RUNTIME_BUSY", "Image generation is being set up. Try again when setup finishes.");
    const input = structuredClone(value) as GenerationInput;
    if (input.images !== undefined && (!Array.isArray(input.images) || input.images.some(id => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)))) throw new ApiError(400, "INVALID_INPUTS", "Choose reference images uploaded to this studio.");
    for (const id of input.images ?? []) this.store.input(id, userId);
    const configuration = settingsView(this.store).modelConfigurations.find(item => item.modelId === input.modelId);
    if (!configuration?.enabled) throw new ApiError(400, "MODEL_DISABLED", "Enable this model in Hardware settings before generating.");
    const model = configuredModel(configuration, this.store);
    const operation = input.operation ?? ((input.images?.length ?? 0) ? FAMILY_RECIPES[model.familyId].operations.includes("image-to-image") ? "image-to-image" : "reference" : "text-to-image");
    const snapshot = compileGeneration({ ...input, operation, images: (input.images ?? []).map(id => ({ filename: `${id}.png`, subfolder: "", type: "input" as const })) }, model);
    input.seed = snapshot.parameters.seed; input.operation = operation;
    await this.refreshWorkers();
    const workers = this.availableWorkers(configuration, snapshot);
    if (!workers.length) {
      const issues = this.store.settings().workers.filter(worker => configuration.workerIds.includes(worker.id)).flatMap(worker => {
        const state = this.workers.get(worker.id);
        return state?.connected && state.discovery ? checkCapabilities(snapshot, state.discovery).issues.map(issue => issue.message) : [state?.error ?? "Worker is not connected."];
      });
      throw new ApiError(409, "MODEL_UNAVAILABLE", issues[0] ?? "Connect a compatible worker with the required model files.");
    }
    const base = model.defaults ?? FAMILY_RECIPES[model.familyId].defaults;
    const pixels = snapshot.parameters.width * snapshot.parameters.height;
    const defaultPixels = (base.width ?? 1024) * (base.height ?? 1024);
    // Until a larger canvas is calibrated, use a conservative growth estimate.
    const scale = Math.max(1, pixels / defaultPixels);
    const cutout = snapshot.auxiliaryArtifacts?.length ? BIREFNET_MEMORY : { ramBytes: 0, vramBytes: 0 };
    const memory = { ramBytes: Math.ceil(configuration.memory.ramBytes * scale) + cutout.ramBytes, vramBytes: Math.ceil(configuration.memory.vramBytes * scale) + cutout.vramBytes };
    const placements: PlacementSnapshot[] = workers.map(worker => ({ worker: structuredClone(worker), memory }));
    if (this.runtimeSetupActive) throw new ApiError(409, "RUNTIME_BUSY", "Image generation is being set up. Try again when setup finishes.");
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
      return { ...worker, connected: state?.connected ?? false, status: active ? "busy" : state?.connected ? "ready" : "unavailable", error: state?.error, version: state?.version, canRelease: this.canReleaseWorker(worker) };
    }) };
  }
  /** The worker acknowledges a request; ComfyUI releases its caches asynchronously. */
  async releaseWorkerMemory(id: string): Promise<{ requested: true }> {
    const worker = this.store.settings().workers.find(item => item.id === id);
    if (!worker) throw new ApiError(404, "WORKER_NOT_FOUND", "This worker no longer exists. Refresh activity.");
    if (this.stopping) throw new ApiError(503, "STUDIO_STOPPING", "The studio is restarting. Try again shortly.");
    if (this.runtimeSetupActive) throw new ApiError(409, "RUNTIME_BUSY", "Wait for image generation setup to finish before releasing worker memory.");
    const state = this.workers.get(worker.id);
    if (!worker.enabled || !state?.connected || state.identity !== workerIdentity(worker)) throw new ApiError(409, "WORKER_UNAVAILABLE", "The worker must be enabled and connected before releasing its memory.");
    if (this.releasePending(worker)) throw new ApiError(409, "WORKER_RELEASE_PENDING", "Memory release is already in progress for this worker or GPU.");
    if (this.workerBusy(worker) || !await this.releaseWorker(worker)) throw new ApiError(409, "WORKER_BUSY", "The worker or its GPU has active or unresolved work. Wait for it to finish before releasing memory.");
    return { requested: true };
  }
  private leases(worker: WorkerSettings): ResourceLease[] {
    const images = this.store.activeJobs().filter(job => job.status !== "queued" && job.workerId).flatMap(job => {
      const placement = job.placements.find(item => item.worker.id === job.workerId);
      if (!placement || hostKey(placement.worker) !== hostKey(worker)) return [];
      return [{ id: job.id, budget: { ramBytes: placement.memory.ramBytes, gpus: { [deviceKey(placement.worker)]: placement.memory.vramBytes } } }];
    });
    return worker.location === "local" ? [...images, ...this.textLeases.values()] : images;
  }
  /** Reserve before awaiting cache release, and retain the lease until the container is confirmed stopped. */
  async reserveTextGpu(gpuIds: string[], memory: { ramBytes: number; vramBytes: number }, signal: AbortSignal): Promise<{ gpuId: string; release: () => void; resident: (identity: string, vramBytes: number) => void; admit: () => Promise<void> }> {
    signal.throwIfAborted();
    if (this.stopping || this.runtimeSetupActive) throw new ApiError(409, "RUNTIME_BUSY", "Wait for GPU setup to finish before using the local assistant.");
    const inventory = await this.hardwareReport(true);
    signal.throwIfAborted();
    if (this.stopping || this.runtimeSetupActive) throw new ApiError(409, "RUNTIME_BUSY", "GPU setup changed while checking the local assistant.");
    const settings = this.store.settings();
    const candidates = inventory.gpus.filter(gpu => gpuIds.includes(gpu.id)).sort((a, b) => (b.memory.totalBytes - (b.memory.usedBytes ?? b.memory.totalBytes)) - (a.memory.totalBytes - (a.memory.usedBytes ?? a.memory.totalBytes)));
    const busy = () => this.store.activeJobs().filter(job => job.status !== "queued").flatMap(job => job.placements.filter(placement => placement.worker.id === job.workerId)).filter(placement => placement.worker.location === "local");
    let reason = "No selected GPU is available. Finish an image generation or choose another GPU for the local assistant.";
    for (const gpu of candidates) {
      signal.throwIfAborted();
      if (busy().some(placement => !placement.worker.deviceIds.length) || [...this.textLeases.values()].some(lease => Object.hasOwn(lease.budget.gpus, gpu.id))) continue;
      if (gpu.memory.totalBytes < memory.vramBytes + settings.policy.vramReserveBytes) { reason = "The local model's VRAM budget and reserve do not fit on the selected GPUs."; continue; }
      const id = `text:${randomUUID()}`;
      const lease: ResourceLease = { id, budget: { ramBytes: memory.ramBytes, gpus: { [gpu.id]: memory.vramBytes } } };
      this.textLeases.set(id, lease); this.textLeaseRevision++;
      const release = () => { if (this.textLeases.delete(id)) { this.textLeaseRevision++; void this.tick(); } };
      const resident = (identity: string, vramBytes: number) => {
        if (!this.textLeases.has(id) || !identity || !Number.isSafeInteger(vramBytes) || vramBytes < 0) return;
        lease.allocated = { identity, sampledAt: new Date().toISOString(), ramBytes: 0, gpus: { [gpu.id]: Math.max(1, Math.min(vramBytes, memory.vramBytes)) } };
        if (!vramBytes) delete lease.allocated;
      };
      const admit = async () => {
        const fresh = await this.hardwareReport(true), policy = this.store.settings().policy;
        if (!this.textLeases.has(id) || this.runtimeSetupActive || this.stopping) throw new ApiError(409, 'TEXT_GPU_BUSY', 'The local model GPU reservation changed. Try again shortly.');
        const images = busy().map(placement => ({ id: placement.worker.id, budget: { ramBytes: placement.memory.ramBytes, gpus: { [deviceKey(placement.worker)]: placement.memory.vramBytes } } }));
        // A one-byte incremental request checks the GPU and every retained peak,
        // crediting only allocations reported by their owning runtime.
        const result = checkAdmission({ ramBytes: 0, gpus: { [gpu.id]: 1 } }, inventoryTelemetry(fresh), [...images, ...this.textLeases.values()], { reserveRamBytes: policy.ramReserveBytes, reserveVramBytes: policy.vramReserveBytes, allowGpuSharing: true });
        if (!result.admitted) throw new ApiError(409, 'TEXT_GPU_BUSY', result.reason);
      };
      let retained = false;
      try {
        const workers = settings.workers.filter(worker => worker.enabled && worker.location === "local" && (!worker.deviceIds.length || worker.deviceIds.includes(gpu.id)));
        for (let attempt = 0; attempt < 20; attempt++) {
          signal.throwIfAborted();
          const fresh = await this.hardwareReport(true);
          const other = [...busy().map(placement => ({ id: placement.worker.id, budget: { ramBytes: placement.memory.ramBytes, gpus: { [deviceKey(placement.worker)]: placement.memory.vramBytes } } })), ...[...this.textLeases.values()].filter(item => item.id !== id)];
          const decision = checkAdmission(lease.budget, inventoryTelemetry(fresh), other, { reserveRamBytes: settings.policy.ramReserveBytes, reserveVramBytes: settings.policy.vramReserveBytes, allowGpuSharing: true });
          if (decision.admitted && !this.stopping && !this.runtimeSetupActive) { signal.throwIfAborted(); retained = true; return { gpuId: gpu.id, release, resident, admit }; }
          reason = decision.reason;
          if (!workers.length || !["insufficient-ram", "insufficient-vram"].includes(decision.code)) break;
          if (attempt === 0) for (const worker of workers) {
            // Active image jobs keep their models. Only idle caches can be reclaimed.
            if (busy().some(placement => workersOverlap(placement.worker, worker))) continue;
            await this.releaseWorker(worker);
          }
          await delay(250, undefined, { signal });
        }
      } finally { if (!retained) release(); }
    }
    throw new ApiError(409, "TEXT_GPU_BUSY", reason);
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
  private releasePending(worker: WorkerSettings): boolean {
    for (const [endpoint, item] of this.releasingWorkers) if (item.until <= Date.now()) this.releasingWorkers.delete(endpoint);
    return [...this.releasingWorkers.values()].some(item => workersOverlap(item.worker, worker));
  }
  private workerBusy(worker: WorkerSettings): boolean {
    return this.store.activeJobs().some(job => job.status !== "queued" && (job.workerId === worker.id || job.placements.some(item => item.worker.id === job.workerId && workersOverlap(item.worker, worker))));
  }
  private canReleaseWorker(worker: WorkerSettings): boolean {
    const state = this.workers.get(worker.id);
    return !this.stopping && !this.runtimeSetupActive && worker.enabled && !!state?.connected && state.identity === workerIdentity(worker) && !this.releasePending(worker) && !this.workerBusy(worker);
  }
  private async releaseWorker(worker: WorkerSettings, memoryPressure = false): Promise<boolean> {
    if (this.releasePending(worker)) return false;
    const host = hostKey(worker);
    if (memoryPressure && (this.tickReleasedHosts.has(host) || Date.now() - (this.memoryReleaseAt.get(host) ?? 0) < Math.max(this.pollMs, 1000))) return false;
    const current = this.store.settings().workers.find(item => item.id === worker.id);
    if (!current?.enabled || workerIdentity(current) !== workerIdentity(worker)) return false;
    if (this.workerBusy(worker)) return false;
    this.releasingWorkers.set(worker.baseUrl, { worker, until: Infinity });
    this.releaseAt.set(worker.baseUrl, Date.now());
    this.warmWorkers.delete(worker.id);
    const recordRelease = () => {
      const now = Date.now();
      this.memoryReleaseAt.set(host, now); this.tickReleasedHosts.add(host);
      this.releasingWorkers.set(worker.baseUrl, { worker, until: now + Math.max(this.pollMs, 1000) });
    };
    try {
      const { released } = await this.client(worker).freeIfIdle();
      // Comfy acknowledges /free before its worker finishes unloading and GC.
      // Allow at least one polling interval before evicting another host cache.
      if (released) recordRelease();
      return released;
    } catch (error) { recordRelease(); throw error; }
    finally { if (this.releasingWorkers.get(worker.baseUrl)?.until === Infinity) this.releasingWorkers.delete(worker.baseUrl); }
  }
  private async admission(placement: PlacementSnapshot, reclaim = false): Promise<Admission> {
    const settings = this.store.settings();
    const worker = placement.worker;
    if (this.releasePending(worker)) return { kind: "wait", reason: "Waiting for idle model memory to be released" };
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
      const policy = { reserveRamBytes: settings.policy.ramReserveBytes, reserveVramBytes: settings.policy.vramReserveBytes, allowGpuSharing: worker.location === "local" };
      let result = checkAdmission(budget, telemetry, this.leases(worker), policy);
      const reclaimable = !result.admitted && ["insufficient-ram", "insufficient-vram"].includes(result.code) && (worker.location === "local" && this.textLeases.size > 0 || Date.now() - (this.releaseAt.get(worker.baseUrl) ?? 0) >= 30_000);
      if (reclaim && reclaimable) {
        if (worker.location === "local" && this.textLeases.size && await this.evictText?.()) {
          telemetry = await this.telemetry(worker);
          if (!telemetry) return { kind: "wait", reason: "Waiting for memory measurements after unloading the local assistant" };
          result = checkAdmission(budget, telemetry, this.leases(worker), policy);
        }
        // A previous checkpoint can occupy memory on an otherwise idle worker.
        // Ask that worker to release caches, then measure again. Torch's global
        // free-memory counters are not proof that the studio owns an allocation.
        if (!result.admitted && await this.releaseWorker(worker, true)) {
          telemetry = await this.telemetry(worker);
          if (!telemetry) return { kind: "wait", reason: "Waiting for memory measurements after unloading idle models" };
          result = checkAdmission(budget, telemetry, this.leases(worker), policy);
        }
      }
      if (this.releasePending(worker)) return { kind: "wait", reason: "Waiting for idle model memory to be released" };
      return result.admitted ? { kind: "ready" } : { kind: result.code === "invalid-budget" ? "reject" : "wait", reason: result.reason, reclaimable: !reclaim && reclaimable, ramPressure: result.code === "insufficient-ram" };
    } catch (error) { this.warmWorkers.delete(worker.id); return { kind: "wait", reason: `Waiting for worker memory telemetry: ${message(error)}` }; }
  }
  private lastWorkerUse(worker: WorkerSettings): string | undefined {
    return this.store.jobs().filter(job => job.workerId === worker.id && job.placements.some(item => item.worker.id === worker.id && workerIdentity(item.worker) === workerIdentity(worker)))
      .map(job => job.updatedAt).sort().at(-1);
  }
  private async reclaimHostRam(job: StoredJob, placement: PlacementSnapshot): Promise<Admission> {
    let decision = await this.admission(placement);
    if (placement.worker.location !== "local" || decision.kind !== "wait" || !decision.ramPressure) return decision;
    const candidates = this.store.settings().workers.filter(worker => worker.enabled && worker.location === "local" && worker.baseUrl !== placement.worker.baseUrl)
      .map(worker => ({ worker, lastUsed: this.lastWorkerUse(worker) })).filter(item => item.lastUsed)
      .sort((a, b) => a.lastUsed!.localeCompare(b.lastUsed!));
    for (const { worker } of candidates) {
      const current = this.store.settings().workers.find(item => item.id === placement.worker.id);
      if (this.stopping || this.store.job(job.id).status !== "queued" || !current?.enabled || workerIdentity(current) !== workerIdentity(placement.worker)) break;
      if (Date.now() - (this.releaseAt.get(worker.baseUrl) ?? 0) < 30_000) continue;
      try {
        if (!await this.releaseWorker(worker, true)) continue;
        decision = await this.admission(placement);
        if (decision.kind !== "wait" || !decision.ramPressure) break;
      } catch { /* A different idle worker may still be able to release memory. */ }
    }
    return decision;
  }
  async tick() {
    if (this.ticking || this.stopping || this.runtimeSetupActive) return;
    this.ticking = true;
    this.tickReleasedHosts.clear();
    try {
      for (const job of this.store.activeJobs()) {
        if (this.stopping) break;
        if (job.status !== "queued" || this.flights.has(job.id)) continue;
        let reason = "Waiting for an available worker";
        const rejected = new Set<string>();
        const reclaimable: PlacementSnapshot[] = [];
        const ramPressure = new Set<string>();
        const wanted = modelIdentity(job.snapshot as ExecutionSnapshot);
        const warm = (placement: PlacementSnapshot) => {
          const hint = this.warmWorkers.get(placement.worker.id);
          return hint?.worker === workerIdentity(placement.worker) && hint.model === wanted ? 1 : 0;
        };
        const placements = [...job.placements].sort((a, b) => warm(b) - warm(a));
        // First find a worker that already has room. Reclaiming an earlier
        // candidate's cache must not happen before checking the other GPUs.
        for (const phase of ["available", "candidate", "host"] as const) {
          const candidates = phase === "available" ? placements : phase === "candidate" ? reclaimable : placements.filter(item => item.worker.location === "local" && ramPressure.has(item.worker.id));
          for (const placement of candidates) {
            const unchanged = () => {
              const worker = this.store.settings().workers.find(item => item.id === placement.worker.id);
              const matches = worker?.enabled && workerIdentity(worker) === workerIdentity(placement.worker);
              if (!matches) this.warmWorkers.delete(placement.worker.id);
              return matches;
            };
            if (!unchanged()) { reason = "The configured worker changed. Restore it or cancel this queued job."; continue; }
            const textRevision = this.textLeaseRevision;
            const decision = phase === "host" ? await this.reclaimHostRam(job, placement) : await this.admission(placement, phase === "candidate");
            // Cancellation may arrive while telemetry or cache release is in flight.
            if (this.stopping || this.store.job(job.id).status !== "queued") { reason = ""; break; }
            if (!unchanged()) { reason = "The configured worker changed. Restore it or cancel this queued job."; continue; }
            if (placement.worker.location === "local" && textRevision !== this.textLeaseRevision) { reason = "Checking memory after the local assistant changed its GPU reservation"; continue; }
            if (decision.kind !== "ready") {
              reason = decision.reason;
              if (decision.kind === "reject") rejected.add(placement.worker.id);
              else if (phase === "available" && decision.reclaimable) reclaimable.push(placement);
              if (decision.ramPressure) ramPressure.add(placement.worker.id); else ramPressure.delete(placement.worker.id);
              continue;
            }
            this.store.patchJob(job.id, { status: "preparing", workerId: placement.worker.id, stage: "Checking model files", error: null });
            this.launch(job.id, () => this.execute(job.id, placement));
            reason = ""; break;
          }
          if (!reason) break;
        }
        if (reason && this.store.job(job.id).status === "queued") {
          if (job.placements.length > 0 && rejected.size === job.placements.length) this.store.patchJob(job.id, { status: "failed", stage: "Job exceeds the configured workers' capacity", error: reason });
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
    // Loading another graph can evict the previous model, even if this run fails.
    this.warmWorkers.delete(placement.worker.id);
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
          const placement = job.placements.find(item => item.worker.id === job.workerId);
          const worker = this.store.settings().workers.find(item => item.id === job.workerId);
          if (placement && worker?.enabled && workerIdentity(worker) === workerIdentity(placement.worker)) {
            this.warmWorkers.set(worker.id, { worker: workerIdentity(worker), model: modelIdentity(snapshot) });
          }
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
    if (this.stopping || this.ticking) return;
    const settings = this.store.settings();
    if (!settings.policy.idleUnloadSeconds) return;
    for (const worker of settings.workers.filter(item => item.enabled)) {
      if (this.stopping || this.ticking) return;
      // A submission may have started while another worker was being released.
      const lastUsed = this.lastWorkerUse(worker);
      if (!lastUsed) continue;
      if (Date.now() - Date.parse(lastUsed) < settings.policy.idleUnloadSeconds * 1000 || this.idleReleasedFor.get(worker.baseUrl) === lastUsed || Date.now() - (this.releaseAt.get(worker.baseUrl) ?? 0) < 30_000) continue;
      try {
        if (await this.releaseWorker(worker)) this.idleReleasedFor.set(worker.baseUrl, lastUsed);
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
