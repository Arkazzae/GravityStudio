import { lstat, opendir, realpath, statfs } from "node:fs/promises";
import type { BigIntStats, BigIntStatsFs, Dir } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { BIREFNET_ARTIFACT, UPSCALER_MODELS } from "../../packages/inference/index.ts";
import type { StorageCategoryId, StorageCategoryUsage, StorageMeasurementStatus, StorageUsage } from "../../packages/contracts/storage.ts";
import type { Store } from "./store.ts";

interface StorageFileSystem {
  lstat(path: string): Promise<BigIntStats>;
  realpath(path: string): Promise<string>;
  openDirectory(path: string): Promise<Dir>;
  statfs(path: string): Promise<BigIntStatsFs>;
}
interface StorageUsageOptions {
  modelsDirectory?: string;
  cacheMs?: number;
  maxEntries?: number;
  maxRecords?: number;
  maxDurationMs?: number;
  now?: () => number;
  fs?: Partial<StorageFileSystem>;
}
const categoryLabels: Record<StorageCategoryId, string> = {
  "image-models": "Image models and encoders", "language-models": "Language models (MiMo)",
  tools: "Upscalers and background removal", database: "Database and journals", images: "Local images and uploads",
  runtime: "Worker files and temporary data", other: "Other Studio files",
};
const modelCategories: StorageCategoryId[] = ["image-models", "language-models", "tools"];
const utilityPaths = new Set([BIREFNET_ARTIFACT, ...UPSCALER_MODELS.flatMap(model => model.artifacts)].map(artifact => `${artifact.folder}/${artifact.filename}`));
const weightFile = /\.(?:safetensors|gguf|pth|pt|ckpt|onnx|bin)(?:\.(?:part|[a-f0-9-]+\.partial))?$/i;
const bytes = (value: bigint): number | null => value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const inside = (root: string, path: string) => { const part = relative(root, path); return part === "" || part !== ".." && !part.startsWith(`..${sep}`) && !part.startsWith(sep); };
const number = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function status(items: StorageCategoryUsage[]): StorageMeasurementStatus {
  return items.every(item => item.status === "complete") ? "complete" : items.every(item => item.status === "unavailable") ? "unavailable" : "partial";
}
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError("Storage scan limits must be positive bounded integers.");
  return result;
}

/** Read-only, bounded metadata scans. No weight contents or remote objects are read. */
export class StorageUsageService {
  private readonly store: Pick<Store, "db" | "directory" | "objectStore">;
  private readonly root: string;
  private readonly modelsRoot: string;
  private readonly fs: StorageFileSystem;
  private readonly now: () => number;
  private readonly cacheMs: number;
  private readonly maxEntries: number;
  private readonly maxRecords: number;
  private readonly maxDurationMs: number;
  private cached?: StorageUsage;
  private expires = 0;
  private flight?: Promise<StorageUsage>;

  constructor(store: Pick<Store, "db" | "directory" | "objectStore">, options: StorageUsageOptions = {}) {
    this.store = store; this.root = resolve(store.directory); this.modelsRoot = resolve(options.modelsDirectory ?? join(this.root, "models"));
    if (this.modelsRoot === this.root || inside(this.modelsRoot, this.root)) throw new TypeError("The model directory must not contain the Studio data directory.");
    this.now = options.now ?? Date.now;
    this.cacheMs = bounded(options.cacheMs, 30_000, 300_000);
    this.maxEntries = bounded(options.maxEntries, 100_000, 1_000_000);
    this.maxRecords = bounded(options.maxRecords, 100_000, 1_000_000);
    this.maxDurationMs = bounded(options.maxDurationMs, 5_000, 30_000);
    this.fs = { lstat: path => lstat(path, { bigint: true }), realpath, openDirectory: path => opendir(path, { bufferSize: 64 }), statfs: path => statfs(path, { bigint: true }), ...options.fs };
  }

  view(): Promise<StorageUsage> {
    if (this.cached && this.now() < this.expires) return Promise.resolve(structuredClone(this.cached));
    this.flight ??= this.measure().then(result => { this.cached = result; this.expires = Date.parse(result.cacheExpiresAt); return result; }).finally(() => { this.flight = undefined; });
    return this.flight.then(result => structuredClone(result));
  }

  private modelCategory(path: string): StorageCategoryId {
    if (path === "text" || path.startsWith("text/")) return "language-models";
    if (/^(upscale_models|background_removal)(\/|$)/.test(path) || utilityPaths.has(path.replace(/\.part$/, ""))) return "tools";
    return "image-models";
  }
  private category(path: string, models: boolean): StorageCategoryId {
    const part = relative(models ? this.modelsRoot : this.root, path).split(sep).join("/");
    if (models) return this.modelCategory(part);
    if (part.startsWith("models/")) return this.modelCategory(part.slice(7));
    if (/^(inputs|outputs)(\/|$)/.test(part)) return "images";
    if (/^(runtime|workers)(\/|$)/.test(part)) return "runtime";
    if (/^(studio|\.process-lock)\.sqlite(?:-(?:wal|shm|journal))?$/.test(part)) return "database";
    return "other";
  }

  private async volume(): Promise<StorageUsage["volume"]> {
    try {
      if (!(await this.fs.lstat(this.root)).isDirectory() || await this.fs.realpath(this.root) !== this.root) throw new Error("Unsafe data directory");
      const info = await this.fs.statfs(this.root);
      const totalBytes = bytes(info.blocks * info.bsize), freeBytes = bytes(info.bfree * info.bsize), availableBytes = bytes(info.bavail * info.bsize);
      if (totalBytes === null || freeBytes === null || availableBytes === null || !totalBytes || freeBytes > totalBytes || availableBytes > freeBytes) throw new Error("Invalid filesystem capacity");
      return { status: "available", totalBytes, freeBytes, availableBytes, usedBytes: totalBytes - freeBytes,
        message: "Filesystem containing the Studio data directory. Used space includes other applications and filesystem overhead." };
    } catch {
      return { status: "unavailable", totalBytes: null, usedBytes: null, freeBytes: null, availableBytes: null, message: "The data directory's filesystem capacity could not be read." };
    }
  }

  private async local(): Promise<Pick<StorageUsage, "local" | "largestModelFiles" | "modelFilesTruncated">> {
    const categories = Object.entries(categoryLabels).map(([id, label]) => ({ id: id as StorageCategoryId, label, bytes: 0, allocatedBytes: 0, files: 0, status: "complete" as StorageMeasurementStatus })) as StorageCategoryUsage[];
    const warnings = new Set<string>(), seen = new Set<string>();
    const largestModelFiles: StorageUsage["largestModelFiles"] = []; let modelFiles = 0;
    const started = performance.now(); let inspected = 0, readableRoots = 0, halted = false;
    const allIds = categories.map(item => item.id);
    const issue = (ids: StorageCategoryId[], warning: string, unavailable = false) => {
      warnings.add(warning);
      for (const item of categories.filter(item => ids.includes(item.id))) {
        item.status = unavailable && !item.files ? "unavailable" : "partial";
        if (item.status === "unavailable") { item.bytes = null; item.allocatedBytes = null; }
      }
    };
    const roots = [{ path: this.modelsRoot, models: true }, { path: this.root, models: false }];
    let modelDevice: bigint | undefined;
    for (const root of roots) {
      const ids = root.models ? modelCategories : this.modelsRoot === join(this.root, "models") ? allIds.filter(id => !modelCategories.includes(id)) : allIds;
      if (halted) { issue(ids, "The scan reached its time or entry limit. Reported sizes are only the files measured so far."); continue; }
      try {
        const info = await this.fs.lstat(root.path);
        if (!info.isDirectory() || await this.fs.realpath(root.path) !== root.path) { issue(ids, "An unsafe or symbolic-link storage directory was skipped.", true); continue; }
        if (root.models) modelDevice = info.dev;
        else if (modelDevice !== undefined && modelDevice !== info.dev) warnings.add("Model files are on a different filesystem. The capacity above describes the data directory, not model download space.");
      } catch (error) {
        if (root.models && missing(error)) continue; // An unused model directory is genuinely empty.
        issue(ids, "A configured storage directory could not be read.", true); continue;
      }
      const queue = [{ path: root.path, depth: 0 }];
      while (queue.length) {
        if (inspected >= this.maxEntries || performance.now() - started >= this.maxDurationMs) { halted = true; issue(ids, "The scan reached its time or entry limit. Reported sizes are only the files measured so far."); break; }
        const current = queue.pop()!;
        const affected = current.depth === 0 ? ids : [this.category(current.path, root.models)];
        try {
          // Recheck every directory before opening it; symlinks are never followed.
          const info = await this.fs.lstat(current.path);
          if (!info.isDirectory() || await this.fs.realpath(current.path) !== current.path) { issue(affected, "Symbolic links and changed storage paths were skipped."); continue; }
          const directory = await this.fs.openDirectory(current.path);
          if (current.depth === 0) readableRoots++;
          for await (const entry of directory) {
            if (inspected >= this.maxEntries || performance.now() - started >= this.maxDurationMs) { halted = true; issue(ids, "The scan reached its time or entry limit. Reported sizes are only the files measured so far."); break; }
            inspected++;
            const path = join(current.path, entry.name), id = this.category(path, root.models);
            if (!root.models && path === this.modelsRoot) continue;
            try {
              const info = await this.fs.lstat(path);
              if (info.isSymbolicLink()) { issue([id], "Symbolic links were skipped; their targets are not included."); continue; }
              if (info.isDirectory()) {
                if (current.depth >= 32) issue([id], "A directory exceeded the scan depth limit.");
                else queue.push({ path, depth: current.depth + 1 });
                continue;
              }
              if (!info.isFile()) { issue([id], "Non-regular filesystem entries were skipped."); continue; }
              const identity = `${info.dev}:${info.ino}`;
              if (seen.has(identity)) continue;
              seen.add(identity);
              const size = bytes(info.size), allocated = bytes(info.blocks * 512n);
              if (size === null || allocated === null) { issue([id], "Some file sizes exceed the supported range."); continue; }
              const item = categories.find(item => item.id === id)!;
              if (!number((item.bytes ?? 0) + size) || !number((item.allocatedBytes ?? 0) + allocated)) { issue([id], "Some file sizes exceed the supported range."); continue; }
              item.bytes = (item.bytes ?? 0) + size; item.allocatedBytes = (item.allocatedBytes ?? 0) + allocated; item.files++;
              if (item.status === "unavailable") item.status = "partial";
              if ((id === "image-models" || id === "language-models" || id === "tools") && weightFile.test(path)) {
                const name = relative(root.models ? this.modelsRoot : join(this.root, "models"), path).split(sep).join("/");
                modelFiles++;
                largestModelFiles.push({ name, categoryId: id, bytes: size });
                largestModelFiles.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
                if (largestModelFiles.length > 20) largestModelFiles.pop();
              }
            } catch { issue([id], "Some files could not be measured because they changed or were inaccessible."); }
          }
        } catch { issue(affected, "Some storage directories were inaccessible or changed during the scan.", current.depth === 0); }
        if (halted) break;
      }
    }
    if (!readableRoots) issue(allIds, "Studio file sizes are unavailable.", true);
    const total = categories.reduce((sum, item) => sum + (item.bytes ?? 0), 0), allocated = categories.reduce((sum, item) => sum + (item.allocatedBytes ?? 0), 0);
    return { local: { status: status(categories), bytes: readableRoots && number(total) ? total : null, allocatedBytes: readableRoots && number(allocated) ? allocated : null,
      files: categories.reduce((sum, item) => sum + item.files, 0), categories, warnings: [...warnings] }, largestModelFiles,
      modelFilesTruncated: modelFiles > 20 || categories.some(item => modelCategories.includes(item.id) && item.status !== "complete") };
  }

  private async objects(): Promise<StorageUsage["objectStorage"]> {
    const result: StorageUsage["objectStorage"] = { configured: !!this.store.objectStore, status: "complete", bytes: null, files: 0, inputsBytes: null, outputsBytes: null, unknownSizeFiles: 0,
      message: "Object storage is not configured. Image files are included in local storage." };
    if (!this.store.objectStore) return result;
    result.bytes = result.inputsBytes = result.outputsBytes = 0;
    result.message = "Recorded sizes of Studio-managed S3/RustFS image objects, including pending deletions. This is not bucket capacity, a quota, or remote server disk usage; untracked objects and object versions are excluded.";
    const started = performance.now(), seen = new Set<string>(); let inspected = 0;
    for (const table of ["inputs", "outputs"] as const) {
      let last = 0;
      try {
        const query = this.store.db.prepare(`SELECT rowid,body FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 128`);
        while (true) {
          if (inspected >= this.maxRecords || performance.now() - started >= this.maxDurationMs) { result.status = "partial"; break; }
          const rows = query.all(last) as { rowid: number; body: string }[];
          if (!rows.length) break;
          for (const row of rows) {
            if (inspected++ >= this.maxRecords || performance.now() - started >= this.maxDurationMs) { result.status = "partial"; break; }
            last = row.rowid;
            try {
              const record = JSON.parse(row.body), object = record.object;
              if (!object) continue; // Local records may remain after opting into S3.
              if (object.backend !== "s3" || object.storeId !== this.store.objectStore.id || typeof object.key !== "string" || !object.key) { result.unknownSizeFiles++; result.status = "partial"; continue; }
              if (seen.has(object.key)) continue;
              seen.add(object.key); result.files++;
              if (!number(object.bytes) || record.bytes !== object.bytes || !number(result.bytes! + object.bytes)) { result.unknownSizeFiles++; result.status = "partial"; continue; }
              result.bytes! += object.bytes;
              result[table === "inputs" ? "inputsBytes" : "outputsBytes"]! += object.bytes;
            } catch { result.unknownSizeFiles++; result.status = "partial"; }
          }
          if (inspected >= this.maxRecords) { result.status = "partial"; break; }
          if (rows.length < 128) break;
          await yieldTurn(); // SQLite is synchronous: yield between bounded pages.
        }
      } catch { result.status = result.files ? "partial" : "unavailable"; }
    }
    if (result.status === "unavailable") result.bytes = result.inputsBytes = result.outputsBytes = null;
    if (result.status !== "complete") result.message += " Some records could not be measured; reported sizes are lower bounds.";
    return result;
  }

  private async measure(): Promise<StorageUsage> {
    const sampledAt = new Date(this.now()).toISOString();
    const [volume, local, objectStorage] = await Promise.all([this.volume(), this.local(), this.objects()]);
    return { sampledAt, cacheExpiresAt: new Date(this.now() + this.cacheMs).toISOString(), volume, ...local, objectStorage };
  }
}
