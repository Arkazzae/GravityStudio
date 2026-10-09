import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
    const info = await sharp(bytes, { limitInputPixels: MAX_PIXELS, animated: false }).metadata();
    const format = info.format;
    if (!info.width || !info.height || !["png", "jpeg", "webp"].includes(format ?? "")) throw new Error("Invalid output");
    width = info.width; height = info.height; extension = format === "jpeg" ? "jpg" : format!;
    mimeType = `image/${format}`;
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
