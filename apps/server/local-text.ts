import { ApiError } from '../../packages/contracts/index.ts';
import type { LocalTextStatus, TextModel, TextModels } from '../../packages/contracts/text.ts';
import type { TextConnection } from '../../packages/text/providers.ts';
import { ManagedTextContainer, localTextGpuSupport } from '../../scripts/text-runtime.ts';
import runtimeLock from '../../deploy/llamacpp/runtime.lock.json' with { type: 'json' };
import { LOCAL_TEXT_MODEL, TextModelFiles } from './text-models.ts';
import type { Store } from './store.ts';
import type { Engine } from './engine.ts';

const key = 'local-text-runtime';
const memory = { ramBytes: 12 * 1024 ** 3, vramBytes: 12 * 1024 ** 3 };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
interface Saved { revision: number; gpuIds: string[]; ready: boolean; runtimeRevision: string }
type Reservation = Awaited<ReturnType<Engine['reserveTextGpu']>>;
type Endpoint = Awaited<ReturnType<ManagedTextContainer['start']>>;
export interface LocalTextOptions {
  files?: Pick<TextModelFiles, 'path' | 'installed' | 'download'>;
  container?: Pick<ManagedTextContainer, 'prepare' | 'start' | 'stop' | 'recover' | 'status'>;
  huggingFaceToken?: () => string | undefined;
}

/** Keeps resident weights separate from active requests. GPU leases cover both. */
export class LocalTextRuntime {
  private store: Store;
  private engine: Engine;
  private files: NonNullable<LocalTextOptions['files']>;
  private container: NonNullable<LocalTextOptions['container']>;
  private controller = new AbortController();
  private phase: LocalTextStatus['phase'] = 'idle';
  private message = '';
  private error: string | null = null;
  private installed = false;
  private ready = false;
  private download: LocalTextStatus['download'] = null;
  private setupFlight?: Promise<void>;
  private requestActive = false;
  private changing = false;
  private unloadFlight?: Promise<void>;
  private reservation?: Reservation;
  private endpoint?: Endpoint;
  private maintenance?: ReturnType<typeof setTimeout>;
  private maintenanceFlight?: Promise<void>;
  private lastUsed = 0;

  constructor(store: Store, engine: Engine, options: LocalTextOptions = {}) {
    this.store = store; this.engine = engine;
    this.files = options.files ?? new TextModelFiles(store, { huggingFaceToken: options.huggingFaceToken });
    this.container = options.container ?? new ManagedTextContainer(store.directory, { onProgress: message => { this.message = message; } });
    engine.setTextEviction(() => this.evictIdle());
  }
  private saved(): Saved {
    const saved = this.store.metadata<Saved>(key);
    if (!saved) return { revision: 0, gpuIds: [], ready: false, runtimeRevision: runtimeLock.revision };
    if (!Number.isSafeInteger(saved.revision) || saved.revision < 0 || !Array.isArray(saved.gpuIds) || saved.gpuIds.some(id => typeof id !== 'string') || typeof saved.ready !== 'boolean') throw new ApiError(503, 'LOCAL_TEXT_SETTINGS_INVALID', 'The saved local model configuration is invalid.');
    return saved;
  }
  private open() { if (this.controller.signal.aborted) throw new ApiError(503, 'LOCAL_TEXT_STOPPING', 'The studio is restarting. Try again shortly.'); }
  async initialize() {
    // Stop a possible orphan before the image scheduler can admit new work.
    await this.container.recover();
    try { this.installed = await this.files.installed(); }
    catch (error) { this.error = error instanceof Error ? error.message : 'The local model could not be verified.'; this.phase = 'failed'; }
    const saved = this.saved();
    this.ready = this.installed && saved.ready && saved.runtimeRevision === runtimeLock.revision;
    if (!this.error) this.phase = this.ready ? 'ready' : 'idle';
  }
  private async candidates() {
    const hardware = await this.engine.hardwareReport();
    const saved = this.saved();
    const localWorkers = this.store.settings().workers.filter(worker => worker.location === 'local');
    const local = localWorkers.filter(worker => worker.enabled).flatMap(worker => worker.deviceIds);
    const selected = saved.gpuIds.length ? saved.gpuIds : localWorkers.length ? local : hardware.gpus.map(gpu => gpu.id);
    const eligible = hardware.gpus.filter(gpu => selected.includes(gpu.id) && localTextGpuSupport(gpu).supported && gpu.memory.totalBytes >= memory.vramBytes + this.store.settings().policy.vramReserveBytes);
    return { hardware, eligible };
  }
  async status(): Promise<LocalTextStatus> {
    const saved = this.saved();
    const hardware = await this.engine.hardwareReport();
    const { id, name, quantization, sizeBytes, source, license, contextTokens } = LOCAL_TEXT_MODEL;
    return { revision: saved.revision, model: { id, name, quantization, sizeBytes, source, license, contextTokens }, phase: this.phase,
      ready: this.ready, installed: this.installed, busy: !!this.setupFlight || this.requestActive || !!this.unloadFlight || this.changing,
      message: this.message, error: this.error, download: this.download, gpuId: this.reservation?.gpuId ?? null, gpuIds: [...saved.gpuIds],
      gpus: hardware.gpus.map(gpu => {
        const support = localTextGpuSupport(gpu);
        const fits = gpu.memory.totalBytes >= memory.vramBytes + this.store.settings().policy.vramReserveBytes;
        return { id: gpu.id, name: gpu.name, memoryBytes: gpu.memory.totalBytes, supported: support.supported && fits,
          ...(!support.supported ? { reason: support.reason } : !fits ? { reason: 'This model needs a 12 GiB VRAM budget plus your configured reserve.' } : {}), ...(gpu.pciAddress ? { pciAddress: gpu.pciAddress } : {}) };
      }) };
  }
  async prepare(body: unknown): Promise<LocalTextStatus> {
    this.open();
    if (!object(body) || Object.keys(body).length !== 1 || body.modelId !== LOCAL_TEXT_MODEL.id) throw new ApiError(400, 'INVALID_LOCAL_TEXT_MODEL', 'Choose the supported MiMo model.');
    if (this.setupFlight || this.requestActive || this.changing || this.unloadFlight) throw new ApiError(409, 'LOCAL_TEXT_BUSY', 'Wait for the current local model operation to finish.');
    this.phase = 'preparing'; this.error = null; this.message = 'Preparing the local language model';
    this.ready = false; this.store.setMetadata(key, { ...this.saved(), ready: false });
    this.setupFlight = Promise.resolve().then(async () => {
      const { hardware, eligible } = await this.candidates();
      if (!eligible.length) throw new ApiError(400, 'LOCAL_TEXT_GPU_REQUIRED', 'Select a supported GPU with enough memory for this model.');
      this.phase = 'downloading'; this.message = 'Downloading and verifying MiMo Q8_0';
      await this.files.download(this.controller.signal, progress => { this.download = progress; });
      this.installed = true; this.download = null; this.phase = 'preparing'; this.message = 'Preparing the llama.cpp runtime';
      // Pull once per backend. start verifies each chosen physical device again.
      const backends = new Set<string>();
      for (const gpu of eligible) if (!backends.has(gpu.vendor)) { await this.container.prepare(gpu, hardware, this.controller.signal); backends.add(gpu.vendor); }
      this.ready = true; this.store.setMetadata(key, { ...this.saved(), ready: true, runtimeRevision: runtimeLock.revision });
      this.phase = this.endpoint ? 'loaded' : 'ready'; this.message = 'MiMo is ready. Choose it for the prompt assistant.';
    }).catch(error => {
      this.phase = 'failed'; this.error = error instanceof ApiError ? error.message : this.controller.signal.aborted ? 'Setup was interrupted. Retry after restarting Studio.' : error instanceof Error ? error.message : 'The local model could not be prepared.';
      this.message = ''; this.download = null;
    }).finally(() => { this.setupFlight = undefined; });
    return this.status();
  }
  async configure(body: unknown): Promise<LocalTextStatus> {
    this.open();
    if (!object(body) || Object.keys(body).some(field => !['revision', 'gpuIds'].includes(field)) || !Number.isSafeInteger(body.revision) || !Array.isArray(body.gpuIds) || body.gpuIds.some(id => typeof id !== 'string') || new Set(body.gpuIds).size !== body.gpuIds.length || body.gpuIds.length > 32) throw new ApiError(400, 'INVALID_LOCAL_TEXT_GPUS', 'Choose the GPUs the local assistant may use.');
    if (this.setupFlight || this.requestActive || this.changing || this.unloadFlight) throw new ApiError(409, 'LOCAL_TEXT_BUSY', 'Wait for the local assistant before changing its GPUs.');
    if (body.revision !== this.saved().revision) throw new ApiError(409, 'LOCAL_TEXT_CHANGED', 'Local model settings changed. Reload before saving.');
    this.changing = true;
    try {
      const hardware = await this.engine.hardwareReport(true);
      if (body.gpuIds.some(id => !hardware.gpus.some(gpu => gpu.id === id && localTextGpuSupport(gpu).supported && gpu.memory.totalBytes >= memory.vramBytes + this.store.settings().policy.vramReserveBytes))) throw new ApiError(400, 'INVALID_LOCAL_TEXT_GPUS', 'Choose supported GPUs with enough memory for this model.');
      await this.unload(); this.open();
      this.store.setMetadata(key, { ...this.saved(), revision: Number(body.revision) + 1, gpuIds: body.gpuIds });
      return this.status();
    } finally { this.changing = false; }
  }
  async models(): Promise<TextModels> {
    return { provider: 'local', models: this.ready ? [this.model()] : [] };
  }
  private model(): TextModel { return { id: LOCAL_TEXT_MODEL.id, name: LOCAL_TEXT_MODEL.name, inputTokenLimit: LOCAL_TEXT_MODEL.contextTokens - 2048 - 256, outputTokenLimit: 2048 }; }
  async run<T>(modelId: string, signal: AbortSignal, work: (connection: TextConnection, model: TextModel) => Promise<T>, onAdmitted?: () => void): Promise<T> {
    this.open();
    if (!this.ready || modelId !== LOCAL_TEXT_MODEL.id) throw new ApiError(409, 'LOCAL_TEXT_NOT_READY', 'Download and prepare MiMo in Models → Language first.');
    if (this.requestActive || this.setupFlight || this.changing || this.unloadFlight) throw new ApiError(409, 'LOCAL_TEXT_BUSY', 'The local language model is busy. Try again shortly.');
    this.requestActive = true; this.error = null; clearTimeout(this.maintenance);
    const combined = AbortSignal.any([signal, this.controller.signal]);
    let admitted = false;
    try {
      combined.throwIfAborted();
      if (this.phase === 'failed' && this.reservation) await this.unload();
      if (this.endpoint) {
        const state = await this.container.status();
        if (!state.running || state.containerId !== this.endpoint.containerId) await this.unload();
        else if (!(await this.candidates()).eligible.some(gpu => gpu.id === this.reservation?.gpuId)) await this.unload();
      }
      if (!this.endpoint) {
        // A previous failed stop keeps its reservation until a retry proves exit.
        if (this.reservation) await this.unload();
        const { hardware, eligible } = await this.candidates();
        this.phase = 'loading'; this.message = 'Loading MiMo on an available GPU';
        this.reservation = await this.engine.reserveTextGpu(eligible.map(gpu => gpu.id), memory, combined);
        onAdmitted?.(); admitted = true;
        const gpu = hardware.gpus.find(item => item.id === this.reservation!.gpuId)!;
        this.endpoint = await this.container.start(gpu, hardware, this.files.path, combined);
      }
      this.reservation!.resident(this.endpoint.containerId, this.endpoint.allocatedVramBytes);
      await this.reservation!.admit();
      combined.throwIfAborted();
      if (!admitted) onAdmitted?.();
      this.phase = 'running'; this.message = 'MiMo is generating a response';
      this.scheduleMaintenance();
      const result = await work({ provider: 'openai-compatible', baseUrl: this.endpoint.baseUrl, apiKey: this.endpoint.apiKey }, this.model());
      combined.throwIfAborted();
      this.lastUsed = Date.now(); this.phase = 'loaded'; this.message = 'MiMo is loaded and available';
      return result;
    } catch (error) {
      try { await this.unload(); } catch { /* A failed stop retains the lease and the visible recovery error. */ }
      if (combined.aborted) throw error;
      this.error ??= error instanceof Error ? error.message : 'The local model request failed.';
      this.phase = this.reservation ? 'failed' : this.ready ? 'ready' : 'failed';
      if (!this.reservation) this.message = '';
      throw error instanceof ApiError ? error : new ApiError(503, 'LOCAL_TEXT_FAILED', this.error);
    } finally { this.requestActive = false; this.scheduleMaintenance(); }
  }
  private scheduleMaintenance() {
    clearTimeout(this.maintenance);
    if (!this.endpoint || this.controller.signal.aborted) return;
    this.maintenance = setTimeout(() => {
      this.maintenanceFlight = (async () => {
        if (this.unloadFlight || !this.endpoint) return;
        const endpoint = this.endpoint;
        const state = await this.container.status();
        if (this.endpoint !== endpoint) return;
        if (!state.running || state.containerId !== endpoint.containerId) { if (!this.requestActive) await this.unload(); return; }
        this.reservation?.resident(this.endpoint.containerId, this.endpoint.allocatedVramBytes);
        if (this.requestActive || this.changing) return;
        const idle = this.store.settings().policy.idleUnloadSeconds;
        if (idle && Date.now() - this.lastUsed >= idle * 1000) await this.evictIdle();
      })().catch(() => { /* No fresh proof means memory credits expire conservatively. */ }).finally(() => { this.maintenanceFlight = undefined; this.scheduleMaintenance(); });
    }, 5000);
    this.maintenance.unref();
  }
  async evictIdle(): Promise<boolean> {
    if (this.requestActive || this.setupFlight || this.changing || this.unloadFlight || !this.reservation) return false;
    await this.unload(); return true;
  }
  private unload(): Promise<void> {
    if (this.unloadFlight) return this.unloadFlight;
    if (!this.reservation && !this.endpoint) return Promise.resolve();
    clearTimeout(this.maintenance); this.phase = 'stopping'; this.message = 'Releasing the local model from GPU memory';
    this.unloadFlight = this.container.stop().then(() => {
      this.endpoint = undefined; this.reservation?.release(); this.reservation = undefined;
      this.phase = this.ready ? 'ready' : 'idle'; this.message = 'GPU memory released'; this.error = null;
    }).catch(error => {
      this.phase = 'failed'; this.error = 'Could not confirm that the local model stopped. Its memory reservation is retained. Retry unloading it.';
      throw new ApiError(503, 'LOCAL_TEXT_STOP_FAILED', this.error);
    }).finally(() => { this.unloadFlight = undefined; });
    return this.unloadFlight;
  }
  async release(): Promise<LocalTextStatus> {
    this.open();
    if (this.requestActive || this.setupFlight || this.changing) throw new ApiError(409, 'LOCAL_TEXT_BUSY', 'Wait for the local model request before unloading it.');
    await this.unload(); return this.status();
  }
  async close() {
    this.controller.abort(); clearTimeout(this.maintenance);
    await this.setupFlight; await this.maintenanceFlight;
    await this.unload();
  }
}
