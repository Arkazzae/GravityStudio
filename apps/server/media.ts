import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { ApiError, type PublicInput, type SavedOutput } from "../../packages/contracts/index.ts";
import type { Store, StoredInput, StoredOutput } from "./store.ts";
import type { StoredObject } from "./object-store.ts";

export const MAX_INPUT_BYTES = 20 * 1024 ** 2;
export const MAX_OUTPUT_BYTES = 64 * 1024 ** 2;
const MAX_PIXELS = 80_000_000;
const storageUnavailable = () => new ApiError(503, "MEDIA_STORAGE_UNAVAILABLE", "This image could not be read from its original storage. Check the storage connection and try again.");
function objectStorage(store: Store, object: StoredObject, location: string, bytes: number, sha256?: string) {
  if (!store.objectStore || !object || object.backend !== 's3' || object.storeId !== store.objectStore.id ||
      typeof object.key !== 'string' || !/^[a-f0-9]{64}$/.test(object.sha256) || !object.key.endsWith(`/${location}/${object.sha256}`) ||
      object.bytes !== bytes || (sha256 !== undefined && object.sha256 !== sha256)) throw storageUnavailable();
  return store.objectStore;
}
async function readStored(store: Store, record: StoredInput | StoredOutput, location: string): Promise<Buffer> {
  if (record.object !== undefined) return objectStorage(store, record.object, location, record.bytes, 'sha256' in record ? record.sha256 : undefined).get(record.object, MAX_OUTPUT_BYTES);
  if (!record.path) throw storageUnavailable();
  const info = await lstat(record.path);
  if (!info.isFile() || info.size !== record.bytes || info.size > MAX_OUTPUT_BYTES) throw storageUnavailable();
  return readFile(record.path);
}
export async function saveInput(store: Store, userId: string, bytes: Buffer, suppliedName: string): Promise<PublicInput> {
  if (!bytes.length || bytes.length > MAX_INPUT_BYTES) throw new ApiError(413, "INPUT_TOO_LARGE", "Choose a reference image smaller than 20 MiB.");
  let data: Buffer, width: number, height: number;
  try {
    const source = sharp(bytes, { limitInputPixels: MAX_PIXELS, animated: false });
    const metadata = await source.metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format ?? "")) throw new Error("Unsupported format");
    const result = await source.rotate().png().toBuffer({ resolveWithObject: true });
    data = result.data; width = result.info.width; height = result.info.height;
  } catch { throw new ApiError(400, "INVALID_IMAGE", "Use a valid PNG, JPEG or WebP image up to 80 megapixels."); }
  if (data.length > MAX_OUTPUT_BYTES) throw new ApiError(413, "INPUT_TOO_LARGE", "This reference is too large after decoding. Resize it before uploading.");
  const id = randomUUID();
  const input: PublicInput = { id, name: suppliedName.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 160) || "reference.png", url: `/api/inputs/${id}`, width, height, mimeType: "image/png" };
  let location: { path?: string; object?: StoredObject };
  if (store.objectStore) location = { object: await store.objectStore.put(`inputs/${id}`, data, input.mimeType) };
  else {
    const directory = join(store.directory, "inputs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${id}.png`);
    await writeFile(path, data, { mode: 0o600, flag: "wx" });
    location = { path };
  }
  try { store.saveInput({ ...input, ...location, userId, bytes: data.length }); }
  catch (error) {
    // This UUID belongs only to this upload; a failed metadata commit must not
    // leave an inaccessible reference behind when cleanup remains available.
    if (location.object) await store.objectStore!.delete(location.object).catch(() => {});
    else if (location.path) await unlink(location.path).catch(() => {});
    throw error;
  }
  return input;
}
export async function inputBytes(store: Store, id: string, userId: string): Promise<Buffer> {
  return readStored(store, store.input(id, userId), `inputs/${id}`);
}
export async function outputBytes(store: Store, jobId: string, id: string, userId: string): Promise<Buffer> {
  return readStored(store, store.output(jobId, id, userId), `outputs/${jobId}/${id}`);
}
export async function deleteInput(store: Store, id: string, userId: string): Promise<void> {
  const input = store.beginInputDeletion(id, userId);
  const failed = () => new ApiError(503, "INPUT_DELETE_FAILED", "Could not delete this imported image from storage. Try again.");
  if (!input.object && !input.path) throw failed();
  if (input.object !== undefined) {
    try { await objectStorage(store, input.object, `inputs/${id}`, input.bytes).delete(input.object); }
    catch { throw failed(); }
  }
  if (input.path !== undefined) {
    const root = resolve(store.directory, "inputs");
    const expectedPath = join(root, `${id}.png`);
    try {
      if (!/^[a-f0-9-]{36}$/.test(id) || input.mimeType !== "image/png" || resolve(input.path) !== expectedPath) throw new Error("Invalid input path");
      if (!(await lstat(root)).isDirectory() || !(await lstat(expectedPath)).isFile()) throw new Error("Invalid input file");
      await unlink(expectedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw failed();
    }
  }
  store.finishInputDeletion(id, userId);
}
export async function saveOutput(store: Store, jobId: string, ordinal: number, bytes: Uint8Array, expectedSize?: { width: number; height: number }): Promise<SavedOutput> {
  if (!bytes.length || bytes.length > MAX_OUTPUT_BYTES) throw new ApiError(502, "INVALID_OUTPUT", "The worker returned an image outside the supported size limit.");
  let width: number, height: number, mimeType: string, extension: string;
  try {
    const source = sharp(bytes, { limitInputPixels: MAX_PIXELS, animated: false, failOn: "warning" });
    const info = await source.metadata();
    const format = info.format;
    if (!info.width || !info.height || !["png", "jpeg", "webp"].includes(format ?? "")) throw new Error("Invalid output");
    width = info.width; height = info.height; extension = format === "jpeg" ? "jpg" : format!;
    mimeType = `image/${format}`;
    // Headers alone can describe a valid image whose compressed pixel stream is corrupt.
    // stats decodes the pixels without retaining an additional full raw-image buffer.
    await source.stats();
  } catch { throw new ApiError(502, "INVALID_OUTPUT", "The worker returned an unreadable image."); }
  if (expectedSize && (width !== expectedSize.width || height !== expectedSize.height)) throw new ApiError(502, "INVALID_OUTPUT", "The upscaler returned an image with unexpected dimensions.");
  const id = createHash("sha256").update(`${jobId}:${ordinal}`).digest("hex").slice(0, 32);
  if (["succeeded", "failed", "cancelled"].includes(store.job(jobId).status)) throw new ApiError(409, "JOB_FINISHED", "A finished generation cannot save additional images.");
  const output: SavedOutput = { id, url: `/api/jobs/${jobId}/outputs/${id}`, mimeType, width, height, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  if (store.objectStore) {
    const object = await store.objectStore.put(`outputs/${jobId}/${id}`, bytes, mimeType);
    store.saveOutput(jobId, { ...output, object });
  } else {
    const directory = join(store.directory, "outputs", jobId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${id}.${extension}`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
    store.saveOutput(jobId, { ...output, path });
  }
  return output;
}

export async function deleteOutput(store: Store, jobId: string, id: string, userId: string) {
  // Keep the intent until both the file and database records are gone. A restart
  // can finish a deletion interrupted after unlink but before the transaction.
  const output = store.beginOutputDeletion(jobId, id, userId);
  if (!output.object && !output.path) throw new ApiError(503, "OUTPUT_DELETE_FAILED", "This image has no valid storage location. Restore its storage metadata before deleting it.");
  if (output.object !== undefined) {
    try { await objectStorage(store, output.object, `outputs/${jobId}/${id}`, output.bytes, output.sha256).delete(output.object); }
    catch { throw new ApiError(503, "OUTPUT_DELETE_FAILED", "Could not delete this image from object storage. Try again."); }
  }
  if (output.path !== undefined) {
    const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<string, string>)[output.mimeType];
    const root = resolve(store.directory, "outputs");
    const directory = join(root, jobId);
    const expectedPath = join(directory, `${id}.${extension}`);
    try {
      if (!extension || !/^[a-f0-9-]{36}$/.test(jobId) || !/^[a-f0-9]{32}$/.test(id) || resolve(output.path) !== expectedPath) throw new Error("Invalid output path");
      for (const parent of [root, directory]) {
        if (!(await lstat(parent)).isDirectory()) throw new Error("Invalid output directory");
      }
      if (!(await lstat(expectedPath)).isFile()) throw new Error("Invalid output file");
      await unlink(expectedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ApiError(503, "OUTPUT_DELETE_FAILED", "Could not delete this image from storage. Try again.");
    }
  }
  return store.finishOutputDeletion(jobId, id, userId);
}

type DeletionRecoveryOptions = { local?: boolean; remote?: boolean; continue?: () => boolean };

export async function recoverInputDeletions(store: Store, options: DeletionRecoveryOptions = {}): Promise<void> {
  for (const pending of store.pendingInputDeletions()) {
    if (options.continue && !options.continue()) break;
    try {
      const input = store.input(pending.inputId, pending.userId);
      if (input.object ? options.remote === false : options.local === false) continue;
      await deleteInput(store, pending.inputId, pending.userId);
    } catch (error) { console.error("Pending imported image deletion could not finish:", pending.inputId, error instanceof Error ? error.message : error); }
  }
}

export async function recoverMediaDeletions(store: Store, options: DeletionRecoveryOptions = {}): Promise<void> {
  await recoverOutputDeletions(store, options);
  await recoverInputDeletions(store, options);
}

export async function recoverOutputDeletions(store: Store, options: DeletionRecoveryOptions = {}): Promise<void> {
  for (const pending of store.pendingOutputDeletions()) {
    if (options.continue && !options.continue()) break;
    try {
      const output = store.output(pending.jobId, pending.outputId, pending.userId);
      if (output.object ? options.remote === false : options.local === false) continue;
      await deleteOutput(store, pending.jobId, pending.outputId, pending.userId);
    }
    catch (error) { console.error("Pending image deletion could not finish:", pending.outputId, error instanceof Error ? error.message : error); }
  }
}
