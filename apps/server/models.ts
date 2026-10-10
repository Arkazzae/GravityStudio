import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, statfs, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ApiError } from "../../packages/contracts/index.ts";
import { BIREFNET_ARTIFACT, DEFAULT_MODELS, FAMILY_RECIPES, UPSCALER_MODELS, compileGeneration, getModel, isRelativeFile, type ModelArtifact, type ModelManifest } from "../../packages/inference/index.ts";
import type { Engine } from "./engine.ts";
import { ModelAccessError, checkDownloadUrl, checkModelFileAccess, huggingFaceFile, modelAccessResponse, modelRepositories, modelRepository, type ModelAccessResult, type ModelDownloadAccess, type ModelRepositoryAccess } from "./model-access.ts";
import { modelRegistry, saveImportedModel } from "./registry.ts";
import { defaultModelConfiguration, settingsView } from "./settings.ts";
import type { Store } from "./store.ts";

export { huggingFaceFile } from "./model-access.ts";
export type { ModelAccessResult, ModelAccessStatus, ModelDownloadAccess, ModelRepository, ModelRepositoryAccess } from "./model-access.ts";

const GiB = 1024 ** 3;
const MAX_FILE_BYTES = 100 * GiB;
const MAX_HEADER_BYTES = 8 * 1024 ** 2;
const stateKey = "model-download";
const active = new Set(["downloading", "verifying", "activating"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const now = () => new Date().toISOString();
interface UtilityModel {
  id: string;
  name: string;
  category: "background-removal" | "upscale";
  description: string;
  license?: string;
  licenseUrl?: string;
  artifacts: ModelArtifact[];
}
const utilityModels: UtilityModel[] = [
  { id: "birefnet", name: "BiRefNet", category: "background-removal", artifacts: [{ ...BIREFNET_ARTIFACT }],
    description: "Remove backgrounds after generation with any image model. Qwen Image 2.1 uses its native transparency instead.", license: "MIT" },
  ...UPSCALER_MODELS.map(model => ({ id: model.id, name: model.name, category: "upscale" as const, description: model.description,
    license: model.license, licenseUrl: model.licenseUrl, artifacts: model.artifacts.map(artifact => ({ ...artifact })) })),
];
const downloadError = (code: string, message: string, status = 400) => new ApiError(status, code, message);

export interface ModelDownload {
  id: string; modelId: string; modelName: string;
  status: "downloading" | "verifying" | "activating" | "succeeded" | "failed";
  stage: string; filename?: string; completedFiles: number; totalFiles: number;
  receivedBytes: number; totalBytes: number | null; error?: string; errorCode?: string; access?: ModelDownloadAccess;
  startedAt: string; updatedAt: string;
}

async function regularFile(path: string): Promise<boolean> {
  try { const file = await lstat(path); return file.isFile() && !file.isSymbolicLink() && file.size > 0; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function validateSafetensors(path: string) {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const prefix = Buffer.alloc(8);
    if ((await file.read(prefix, 0, 8, 0)).bytesRead !== 8) throw new Error("Missing header");
    const headerSize = prefix.readBigUInt64LE();
    if (headerSize < 2 || headerSize > MAX_HEADER_BYTES || headerSize + 8n >= BigInt(size)) throw new Error("Invalid header size");
    const bytes = Buffer.alloc(Number(headerSize));
    if ((await file.read(bytes, 0, bytes.length, 8)).bytesRead !== bytes.length) throw new Error("Incomplete header");
    const header: unknown = JSON.parse(bytes.toString("utf8"));
    if (!object(header)) throw new Error("Invalid header");
    const tensors = Object.entries(header).filter(([key]) => key !== "__metadata__");
    if (!tensors.length || tensors.some(([, value]) => !object(value) || typeof value.dtype !== "string" || !Array.isArray(value.shape) || !value.shape.every(dimension => Number.isSafeInteger(dimension) && dimension >= 0) || !Array.isArray(value.data_offsets) || value.data_offsets.length !== 2 || !value.data_offsets.every(offset => Number.isSafeInteger(offset) && offset >= 0) || value.data_offsets[0] > value.data_offsets[1] || value.data_offsets[1] > size - 8 - Number(headerSize))) throw new Error("Invalid tensors");
  } catch { throw downloadError("INVALID_SAFETENSORS", "The downloaded file is not a valid safetensors checkpoint."); }
  finally { await file.close(); }
}

type LibraryEngine = Pick<Engine, "invalidateWorkers" | "refreshWorkers" | "availableWorkers">;
interface LibraryOptions {
  fetch?: typeof fetch;
  huggingFaceToken?: () => string | undefined;
  modelsDirectory?: string;
  availableBytes?: (directory: string) => Promise<number>;
}

export class ModelLibrary {
  private store: Store;
  private engine: LibraryEngine;
  private fetchFile: typeof fetch;
  private huggingFaceToken: () => string | undefined;
  private availableBytes: (directory: string) => Promise<number>;
  private controller = new AbortController();
  private flight?: Promise<void>;
  private activation?: Promise<Awaited<ReturnType<ModelLibrary["view"]>>>;
  private current: ModelDownload | null;
  private verifiedFiles = new Map<string, { stamp: string; digest: string }>();
  readonly modelsDirectory: string;

  constructor(store: Store, engine: LibraryEngine, options: LibraryOptions = {}) {
    this.store = store; this.engine = engine; this.fetchFile = options.fetch ?? fetch;
    this.huggingFaceToken = options.huggingFaceToken ?? (() => undefined);
    this.modelsDirectory = resolve(options.modelsDirectory ?? join(store.directory, "models"));
    this.availableBytes = options.availableBytes ?? (async directory => { const stats = await statfs(directory); return stats.bavail * stats.bsize; });
    this.current = store.metadata<ModelDownload>(stateKey) ?? null;
    if (this.current && active.has(this.current.status)) this.update({ status: "failed", stage: "Download interrupted", error: "The server restarted before the download finished. Try downloading this model again." });
  }

  private update(patch: Partial<ModelDownload>, persist = true) {
    this.current = { ...this.current!, ...patch, updatedAt: now() };
    if (persist) this.store.setMetadata(stateKey, this.current);
  }

  busy() { return !!this.flight || !!this.activation; }

  async view() {
    const settings = settingsView(this.store);
    const models = await Promise.all(modelRegistry(this.store).map(async model => {
      const artifacts = await Promise.all(model.artifacts.map(async artifact => ({ role: artifact.role, filename: artifact.filename, installed: await regularFile(join(this.modelsDirectory, artifact.folder, artifact.filename)) })));
      const downloadable = model.artifacts.every(artifact => { try { huggingFaceFile(artifact.source); return true; } catch { return false; } });
      return { id: model.id, name: model.name, familyId: model.familyId, family: FAMILY_RECIPES[model.familyId].name, description: model.description, license: model.license, licenseUrl: model.licenseUrl,
        repositories: modelRepositories(model.artifacts.map(artifact => artifact.source)),
        source: DEFAULT_MODELS.some(item => item.id === model.id) ? "catalog" as const : "huggingface" as const,
        installed: artifacts.every(artifact => artifact.installed), enabled: settings.modelConfigurations.some(configuration => configuration.modelId === model.id && configuration.enabled), downloadable,
        ...(!downloadable ? { unavailableReason: "This catalog model has no Hugging Face download source. Add its checkpoint to the shared model folder to use it." } : {}), artifacts };
    }));
    const tools = await Promise.all(utilityModels.map(async model => {
      const artifacts = await Promise.all(model.artifacts.map(async artifact => ({ role: artifact.role, filename: artifact.filename, installed: await regularFile(join(this.modelsDirectory, artifact.folder, artifact.filename)) })));
      const installed = artifacts.every(artifact => artifact.installed);
      return { id: model.id, name: model.name, familyId: model.category, family: model.category === "upscale" ? "Upscaling" : "Background removal", kind: "utility" as const,
        category: model.category, description: model.description, license: model.license, licenseUrl: model.licenseUrl, source: "catalog" as const,
        repositories: modelRepositories(model.artifacts.map(artifact => artifact.source)), installed, enabled: installed, downloadable: true, artifacts };
    }));
    return { models: [...models, ...tools], download: this.current ? { ...this.current } : null };
  }

  async checkAccess(value: unknown, signal?: AbortSignal): Promise<ModelAccessResult> {
    if (this.controller.signal.aborted) throw downloadError("STUDIO_STOPPING", "The studio is restarting. Try again shortly.", 503);
    if (!object(value) || Object.keys(value).length !== 1 || !(typeof value.modelId === "string" || typeof value.url === "string")) throw downloadError("INVALID_MODEL_REQUEST", "Choose a model or provide a Hugging Face checkpoint link.");
    let modelId: string | undefined;
    let sources: string[];
    if (typeof value.modelId === "string") {
      const model = utilityModels.find(model => model.id === value.modelId) ?? getModel(value.modelId, modelRegistry(this.store));
      modelId = model.id;
      sources = model.artifacts.map(artifact => huggingFaceFile(artifact.source));
    } else sources = [huggingFaceFile(value.url)];
    const cancelled = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
    const checkCancelled = () => { if (cancelled.aborted) throw downloadError("MODEL_ACCESS_CANCELLED", "The model access check was cancelled. Try again.", 499); };
    checkCancelled();
    const token = this.huggingFaceToken() ?? process.env.HF_TOKEN;
    const requestSignal = AbortSignal.any([cancelled, AbortSignal.timeout(15_000)]);
    const checked = await Promise.all([...new Set(sources)].map(source => checkModelFileAccess(source, { fetch: this.fetchFile, token, signal: requestSignal })));
    checkCancelled();
    if ((this.huggingFaceToken() ?? process.env.HF_TOKEN) !== token) throw downloadError("MODEL_ACCESS_CHANGED", "Hugging Face credentials changed during this check. Check access again.", 409);
    const repositories = new Map<string, ModelRepositoryAccess>();
    for (const result of checked) {
      const previous = repositories.get(result.id);
      if (!previous || previous.status === "available" || result.status === "gated") repositories.set(result.id, result);
    }
    return { ...(modelId ? { modelId } : {}), available: checked.length > 0 && checked.every(result => result.status === "available"), hasToken: !!token, checkedAt: now(), repositories: [...repositories.values()] };
  }

  start(value: unknown): ModelDownload {
    if (this.controller.signal.aborted) throw downloadError("STUDIO_STOPPING", "The studio is restarting. Try again shortly.", 503);
    if (this.busy()) throw downloadError("MODEL_DOWNLOAD_BUSY", "Wait for the current model operation to finish.", 409);
    if (!object(value)) throw downloadError("INVALID_MODEL_REQUEST", "Choose a model or provide a Hugging Face checkpoint link.");
    let model: ModelManifest | UtilityModel;
    if (typeof value.modelId === "string" && Object.keys(value).length === 1) {
      model = utilityModels.find(model => model.id === value.modelId) ?? getModel(value.modelId, modelRegistry(this.store));
    } else {
      if (Object.keys(value).some(key => !["url", "name", "familyId"].includes(key)) || value.familyId !== "sdxl" || typeof value.name !== "string" || !value.name.trim() || value.name.length > 120 || /[\x00-\x1f\x7f]/.test(value.name)) throw downloadError("INVALID_MODEL_REQUEST", "Give this SDXL / Illustrious checkpoint a name of up to 120 characters.");
      const source = huggingFaceFile(value.url);
      const fingerprint = createHash("sha256").update(source).digest("hex").slice(0, 16);
      const filename = decodeURIComponent(basename(new URL(source).pathname));
      model = { id: `hf-${fingerprint}`, name: value.name.trim(), familyId: "sdxl", revision: "1", description: "An imported checkpoint using the shared SDXL / Illustrious recipe.", artifacts: [{ role: "checkpoint", folder: "checkpoints", filename: `hf-${fingerprint}/${filename}`, source }] };
      const existing = modelRegistry(this.store).find(item => item.id === model.id);
      if (existing) model = { ...existing, name: model.name };
      if ("familyId" in model) saveImportedModel(this.store, model);
    }
    for (const artifact of model.artifacts) huggingFaceFile(artifact.source);
    this.current = { id: randomUUID(), modelId: model.id, modelName: model.name, status: "downloading", stage: "Preparing download", completedFiles: 0, totalFiles: model.artifacts.length, receivedBytes: 0, totalBytes: null, startedAt: now(), updatedAt: now() };
    this.store.setMetadata(stateKey, this.current);
    this.flight = Promise.resolve().then(() => this.download(model)).catch(error => {
      this.update({ status: "failed", stage: "Download stopped", error: error instanceof ApiError ? error.message : this.controller.signal.aborted ? "The studio stopped before the download finished. Try again after restarting." : "The model download failed. Check the connection and available disk space, then try again.",
        errorCode: error instanceof ApiError ? error.code : "MODEL_DOWNLOAD_FAILED", ...(error instanceof ModelAccessError ? { access: error.access } : {}) });
    }).finally(() => { this.flight = undefined; });
    return { ...this.current };
  }

  private async target(artifact: ModelArtifact) {
    if (!isRelativeFile(artifact.filename) || !artifact.filename.endsWith(".safetensors")) throw downloadError("INVALID_MODEL_FILE", "Model downloads must be safetensors files inside the shared model folder.");
    await mkdir(this.modelsDirectory, { recursive: true, mode: 0o700 });
    if (await realpath(this.modelsDirectory) !== this.modelsDirectory) throw downloadError("UNSAFE_MODEL_DIRECTORY", "The managed model directory cannot be a symbolic link.");
    let current = this.modelsDirectory;
    for (const part of [artifact.folder, ...artifact.filename.split("/").slice(0, -1)]) {
      current = join(current, part);
      try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (!(await lstat(current)).isDirectory() || await realpath(current) !== current) throw downloadError("UNSAFE_MODEL_DIRECTORY", "Model folders cannot contain symbolic links.");
    }
    const destination = join(this.modelsDirectory, artifact.folder, artifact.filename);
    try {
      const existing = await lstat(destination);
      if (!existing.isFile() || existing.isSymbolicLink()) throw downloadError("MODEL_FILE_CONFLICT", "A different file already occupies this model path. It has been left unchanged.", 409);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return destination;
  }

  private async request(source: string, signal: AbortSignal) {
    let url = new URL(huggingFaceFile(source));
    const token = this.huggingFaceToken() ?? process.env.HF_TOKEN;
    for (let redirects = 0; redirects < 8; redirects++) {
      checkDownloadUrl(url);
      const headers: Record<string, string> = { "Accept-Encoding": "identity" };
      if (url.hostname === "huggingface.co" && token) headers.Authorization = `Bearer ${token}`;
      const response = await this.fetchFile(url, { headers, redirect: "manual", signal });
      if (response.headers.get("x-error-code") === "GatedRepo") {
        await response.body?.cancel();
        throw new ModelAccessError(modelAccessResponse(modelRepository(source), response));
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location"); await response.body?.cancel();
        if (!location) throw downloadError("INVALID_MODEL_REDIRECT", "The model download returned an incomplete redirect.");
        url = new URL(location, url); continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ModelAccessError(modelAccessResponse(modelRepository(source), response));
      }
      return response;
    }
    throw downloadError("MODEL_REDIRECT_LIMIT", "The model download returned too many redirects.");
  }

  private async hashFile(path: string) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { signal: this.controller.signal })) hash.update(chunk);
    return hash.digest("hex");
  }

  private async fileStamp(path: string) {
    const file = await lstat(path, { bigint: true });
    return `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
  }

  private async verifyFile(path: string, artifact: ModelArtifact): Promise<string> {
    const before = await this.fileStamp(path);
    const cached = this.verifiedFiles.get(path);
    if (cached?.stamp === before && (!artifact.sha256 || cached.digest === artifact.sha256)) return cached.digest;
    const digest = await this.hashFile(path);
    if (artifact.sha256 && digest !== artifact.sha256) throw downloadError("MODEL_FILE_CONFLICT", "An existing model file does not match the expected checksum. It has been left unchanged.", 409);
    await validateSafetensors(path);
    if (before !== await this.fileStamp(path)) throw downloadError("MODEL_FILE_CHANGED", "The model file changed while it was being verified. Try again.", 409);
    this.verifiedFiles.set(path, { stamp: before, digest });
    return digest;
  }

  private async downloadFile(artifact: ModelArtifact, verified: (digest: string) => void): Promise<string> {
    const destination = await this.target(artifact);
    this.update({ filename: artifact.filename, receivedBytes: 0, totalBytes: null, status: "verifying", stage: "Checking existing files" });
    if (await regularFile(destination)) {
      if (!artifact.sha256) throw downloadError("MODEL_FILE_CONFLICT", "An existing model file has no recorded checksum. It has been left unchanged.", 409);
      const digest = await this.verifyFile(destination, artifact);
      verified(digest);
      return digest;
    }
    const partial = `${destination}.part`;
    // Partial files belong exclusively to this single-download manager and are never visible to ComfyUI.
    await unlink(partial).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    const stalled = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, stalled.signal, AbortSignal.timeout(24 * 60 * 60 * 1000)]);
    let timer = setTimeout(() => stalled.abort(), 60_000);
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => stalled.abort(), 60_000); };
    try {
      this.update({ status: "downloading", stage: "Downloading from Hugging Face" });
      const response = await this.request(artifact.source!, signal);
      const length = response.headers.get("content-length");
      const total = length && /^\d+$/.test(length) ? Number(length) : 0;
      if (!Number.isSafeInteger(total) || total < 10 || total > MAX_FILE_BYTES || !response.body) { await response.body?.cancel(); throw downloadError("INVALID_MODEL_SIZE", "The model server did not provide a supported file size (up to 100 GB)."); }
      if (await this.availableBytes(dirname(destination)) < total + GiB) { await response.body.cancel(); throw downloadError("MODEL_DISK_SPACE", "There is not enough free disk space for this file plus 1 GB of reserve."); }
      this.update({ totalBytes: total });
      const file = await open(partial, "wx", 0o600);
      const reader = response.body.getReader();
      const hash = createHash("sha256");
      let received = 0, persistedAt = 0;
      try {
        while (true) {
          touch();
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > total) throw downloadError("MODEL_SIZE_CHANGED", "The model file exceeded its declared size.");
          hash.update(value);
          await file.writeFile(value);
          const persist = Date.now() - persistedAt >= 1000;
          this.update({ receivedBytes: received }, persist);
          if (persist) persistedAt = Date.now();
        }
        if (received !== total) throw downloadError("MODEL_INCOMPLETE", "The model download ended before the complete file arrived.");
        await file.sync();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await file.close(); }
      const digest = hash.digest("hex");
      this.update({ status: "verifying", stage: "Verifying the downloaded file" });
      if (artifact.sha256 && digest !== artifact.sha256) throw downloadError("MODEL_CHECKSUM_MISMATCH", "The downloaded file does not match the model's SHA-256 checksum. Retry the download.");
      await validateSafetensors(partial);
      // Persist an imported file's identity before publishing it, so restart/retry can verify it.
      verified(digest);
      // A hard link publishes the complete file atomically without replacing an existing file.
      await link(partial, destination);
      await unlink(partial);
      this.verifiedFiles.set(destination, { stamp: await this.fileStamp(destination), digest });
      return digest;
    } finally {
      clearTimeout(timer);
      stalled.abort();
      await unlink(partial).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    }
  }

  private async download(model: ModelManifest | UtilityModel) {
    for (const artifact of model.artifacts) {
      await this.downloadFile(artifact, digest => {
        if ("familyId" in model && !DEFAULT_MODELS.some(item => item.id === model.id)) { artifact.sha256 = digest; model.revision = digest.slice(0, 16); saveImportedModel(this.store, model); }
      });
      this.update({ completedFiles: this.current!.completedFiles + 1 });
    }
    this.update({ status: "activating", stage: "Checking the image engine" });
    if (!("familyId" in model)) {
      this.engine.invalidateWorkers();
      await this.engine.refreshWorkers(true);
      this.update({ status: "succeeded", stage: model.category === "upscale" ? "Downloaded. Upscaling is available on compatible image workers." : "Downloaded. Transparent background is available on compatible image workers." });
      return;
    }
    try {
      await this.activateModel({ modelId: model.id });
      this.update({ status: "succeeded", stage: "Ready to generate" });
    } catch (error) {
      if (error instanceof ApiError && error.code === "MODEL_WORKER_UNAVAILABLE") this.update({ status: "succeeded", stage: "Downloaded. Start the image engine, then activate this model." });
      else throw error;
    }
  }

  activate(value: unknown) {
    if (this.controller.signal.aborted) throw downloadError("STUDIO_STOPPING", "The studio is restarting. Try again shortly.", 503);
    if (this.busy()) throw downloadError("MODEL_DOWNLOAD_BUSY", "Wait for the current model operation to finish.", 409);
    this.activation = this.activateModel(value).finally(() => { this.activation = undefined; });
    return this.activation;
  }

  private async activateModel(value: unknown) {
    if (!object(value) || Object.keys(value).length !== 1 || typeof value.modelId !== "string") throw downloadError("INVALID_MODEL_REQUEST", "Choose the model to activate.");
    const model = getModel(value.modelId, modelRegistry(this.store));
    if (!(await Promise.all(model.artifacts.map(artifact => regularFile(join(this.modelsDirectory, artifact.folder, artifact.filename))))).every(Boolean)) throw downloadError("MODEL_FILES_MISSING", "Download this model's files before activating it.");
    for (const artifact of model.artifacts) await this.verifyFile(await this.target(artifact), artifact);
    let managed: { id: string; baseUrl: string }[] = [];
    try { const plan = JSON.parse(await readFile(join(this.store.directory, "runtime", "plan.json"), "utf8")); if (Array.isArray(plan.workers)) managed = plan.workers; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw downloadError("MODEL_WORKER_UNAVAILABLE", "Set up the image engine before activating this model.", 409); }
    const settings = settingsView(this.store);
    const workers = settings.workers.filter(worker => worker.enabled && worker.location === "local" && managed.some(item => item.id === worker.id && item.baseUrl === worker.baseUrl));
    const current = settings.modelConfigurations.find(item => item.modelId === model.id) ?? defaultModelConfiguration(model);
    const manual = current.workerSelection === "manual";
    const unmanagedIds = current.workerIds.filter(id => !managed.some(worker => worker.id === id));
    const configuration = { ...current, enabled: true, artifacts: Object.fromEntries(model.artifacts.map(artifact => [artifact.role, artifact.filename])), workerIds: manual ? [...current.workerIds] : [...new Set([...unmanagedIds, ...workers.map(worker => worker.id)])] };
    this.engine.invalidateWorkers();
    await this.engine.refreshWorkers(true);
    const snapshot = compileGeneration({ modelId: model.id, prompt: "Model availability check", seed: 0 }, model);
    const checkedIds = this.engine.availableWorkers({ ...configuration, workerIds: configuration.workerIds.filter(id => workers.some(worker => worker.id === id)) }, snapshot).map(worker => worker.id);
    if (!checkedIds.length) throw downloadError("MODEL_WORKER_UNAVAILABLE", "The model is downloaded. Start the image engine and activate it when a selected GPU worker can see its files.", 409);
    // Merge into the latest revision so a hardware setting saved during discovery is preserved.
    const latest = settingsView(this.store);
    if (JSON.stringify(latest.modelConfigurations.find(item => item.modelId === model.id)) !== JSON.stringify(current)) throw downloadError("MODEL_SETTINGS_CHANGED", "Model settings changed while checking its files. Activate it again to use the latest worker selection.", 409);
    const stillAvailable = checkedIds.some(id => latest.workers.some(worker => worker.id === id && worker.enabled && workers.some(previous => previous.id === id && previous.baseUrl === worker.baseUrl)));
    if (!stillAvailable) throw downloadError("MODEL_WORKER_UNAVAILABLE", "GPU selection changed while checking this model. Activate it again.", 409);
    latest.modelConfigurations = latest.modelConfigurations.map(item => item.modelId === model.id ? configuration : item);
    this.store.saveSettings(latest);
    return this.view();
  }

  async close() { this.controller.abort(); await Promise.allSettled([this.flight, this.activation]); }
  async waitForIdle() { await this.flight; }
}
