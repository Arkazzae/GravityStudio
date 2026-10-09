import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { ApiError, type PublicInput, type SavedOutput } from "../../packages/contracts/index.ts";
import type { Store } from "./store.ts";

export const MAX_INPUT_BYTES = 20 * 1024 ** 2;
export const MAX_OUTPUT_BYTES = 64 * 1024 ** 2;
const MAX_PIXELS = 80_000_000;
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
  const directory = join(store.directory, "inputs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${id}.png`);
  await writeFile(path, data, { mode: 0o600, flag: "wx" });
  const input: PublicInput = { id, name: suppliedName.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 160) || "reference.png", url: `/api/inputs/${id}`, width, height, mimeType: "image/png" };
  store.saveInput({ ...input, path, userId, bytes: data.length });
  return input;
}
export async function inputBytes(store: Store, id: string, userId: string): Promise<Buffer> {
  return readFile(store.input(id, userId).path);
}
export async function saveOutput(store: Store, jobId: string, ordinal: number, bytes: Uint8Array): Promise<SavedOutput> {
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
  const id = createHash("sha256").update(`${jobId}:${ordinal}`).digest("hex").slice(0, 32);
  const directory = join(store.directory, "outputs", jobId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${id}.${extension}`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  const output: SavedOutput = { id, url: `/api/jobs/${jobId}/outputs/${id}`, mimeType, width, height, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  store.saveOutput(jobId, { ...output, path });
  return output;
}

export async function deleteOutput(store: Store, jobId: string, id: string, userId: string) {
  // Keep the intent until both the file and database records are gone. A restart
  // can finish a deletion interrupted after unlink but before the transaction.
  const output = store.beginOutputDeletion(jobId, id, userId);
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
  return store.finishOutputDeletion(jobId, id, userId);
}

export async function recoverOutputDeletions(store: Store): Promise<void> {
  for (const pending of store.pendingOutputDeletions()) {
    try { await deleteOutput(store, pending.jobId, pending.outputId, pending.userId); }
    catch (error) { console.error("Pending image deletion could not finish:", pending.outputId, error instanceof Error ? error.message : error); }
  }
}
