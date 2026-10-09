import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { ApiError } from "../../packages/contracts/index.ts";

const MAX_BYTES = 64 * 1024 ** 2;
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const LOCATION = new RegExp(`^(?:inputs/${UUID}|outputs/${UUID}/[a-f0-9]{32})$`);
const HASH = /^[a-f0-9]{64}$/;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const failure = (code: string, message: string, status = 503) => new ApiError(status, code, message);
const missing = (error: unknown) => ["NoSuchKey", "NotFound"].includes((error as { name?: string })?.name ?? "");

export interface StoredObject { backend: "s3"; storeId: string; key: string; sha256: string; bytes: number }
export interface AssetObjectStore {
  readonly id: string;
  put(location: string, data: Uint8Array, mimeType: string): Promise<StoredObject>;
  get(ref: StoredObject, maxBytes: number): Promise<Buffer>;
  delete(ref: StoredObject): Promise<void>;
  close(): void;
}
export interface S3ObjectStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  timeoutMs: number;
}

function validateConfig(config: S3ObjectStoreConfig): S3ObjectStoreConfig {
  let endpoint: URL;
  try { endpoint = new URL(config.endpoint); }
  catch { throw new Error("Configure an S3 endpoint origin."); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/" ||
    !(endpoint.protocol === "https:" || endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))) throw new Error("Use an HTTPS S3 origin or loopback HTTP.");
  if (!/^[a-z0-9-]{1,63}$/.test(config.region)) throw new Error("Configure a valid S3 region.");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || /\.\.|\.-|-\./.test(config.bucket) || /^\d+\.\d+\.\d+\.\d+$/.test(config.bucket)) throw new Error("Configure a valid private S3 bucket name.");
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_/-]{0,127}$/.test(config.prefix) || config.prefix.endsWith("/") || config.prefix.includes("//")) throw new Error("Configure a valid S3 key prefix of up to 128 characters.");
  if (!config.accessKeyId || !config.secretAccessKey || /[\x00-\x20\x7f]/.test(config.accessKeyId) || /[\x00-\x1f\x7f]/.test(config.secretAccessKey)) throw new Error("Configure explicit private S3 credentials.");
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 120_000) throw new Error("Bound S3 operations to 1–120 seconds.");
  return { ...config, endpoint: endpoint.origin };
}

export function s3ObjectStoreConfig(env: NodeJS.ProcessEnv = process.env): S3ObjectStoreConfig {
  return validateConfig({ endpoint: env.GRAVITY_S3_ENDPOINT ?? "", region: env.GRAVITY_S3_REGION ?? "us-east-1",
    bucket: env.GRAVITY_S3_BUCKET ?? "gravity-studio", prefix: env.GRAVITY_S3_PREFIX ?? "media-v1",
    accessKeyId: env.GRAVITY_S3_ACCESS_KEY_ID ?? "", secretAccessKey: env.GRAVITY_S3_SECRET_ACCESS_KEY ?? "",
    timeoutMs: Number(env.GRAVITY_S3_TIMEOUT_MS ?? 30_000) });
}

export function objectStoreFromEnv(env: NodeJS.ProcessEnv = process.env): AssetObjectStore | null {
  const storage = env.GRAVITY_ASSET_STORAGE ?? "local";
  if (storage === "local") return null;
  if (storage !== "s3") throw new Error("Choose local or s3 asset storage.");
  return new S3ObjectStore(s3ObjectStoreConfig(env));
}

/** Private S3 storage. Public URLs and authorization remain in the Studio API. */
export class S3ObjectStore implements AssetObjectStore {
  readonly id: string;
  private config: S3ObjectStoreConfig;
  private client: S3Client;
  private closed = false;
  private operations = new Set<AbortController>();
  constructor(config: S3ObjectStoreConfig) {
    this.config = validateConfig(config);
    const { endpoint, region, bucket, prefix, accessKeyId, secretAccessKey, timeoutMs } = this.config;
    this.id = digest(Buffer.from(JSON.stringify([endpoint, region, bucket, prefix])));
    this.client = new S3Client({ endpoint, region, forcePathStyle: true, followRegionRedirects: false, credentials: { accessKeyId, secretAccessKey },
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED", maxAttempts: 1,
      requestHandler: { connectionTimeout: 5000, socketTimeout: timeoutMs } });
    // Bound provider XML before the SDK deserializer reads it into memory.
    // Successful GET bodies remain streams and are bounded against their registry record.
    this.client.middlewareStack.add(next => async args => {
      const result = await next(args);
      const response = result.response as { statusCode: number; headers: Record<string, string>; body: unknown };
      if ((args.request as { method: string }).method === "GET" && response.statusCode === 200 || !(response.body instanceof Readable)) return result;
      const body = response.body, maximum = 64 * 1024;
      const tooLarge = () => failure("ASSET_STORAGE_RESPONSE_INVALID", "Object storage returned an oversized response.");
      if (Number(response.headers["content-length"]) > maximum) { body.destroy(); throw tooLarge(); }
      let bytes = 0;
      const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maximum) callback(tooLarge()); else callback(null, chunk);
      } });
      body.on("error", error => bounded.destroy(error));
      bounded.on("close", () => body.destroy());
      response.body = body.pipe(bounded);
      return result;
    }, { name: "boundedS3Responses", step: "deserialize", priority: "low" });
  }
  private reference(ref: StoredObject, maxBytes = MAX_BYTES) {
    if (!ref || ref.backend !== "s3" || ref.storeId !== this.id) throw failure("ASSET_STORAGE_MISMATCH", "The configured object storage does not match this asset.");
    const relative = typeof ref.key === "string" && ref.key.startsWith(`${this.config.prefix}/`) ? ref.key.slice(this.config.prefix.length + 1) : "";
    const location = relative.slice(0, relative.lastIndexOf("/"));
    if (!HASH.test(ref.sha256) || !LOCATION.test(location) || relative !== `${location}/${ref.sha256}` || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > MAX_BYTES) throw failure("INVALID_ASSET_OBJECT", "The saved object reference is invalid.");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES || ref.bytes > maxBytes) throw failure("ASSET_TOO_LARGE", "The saved asset exceeds the read limit.", 413);
  }
  private async operation<T>(code: string, message: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw failure("ASSET_STORAGE_CLOSED", "Object storage is stopping. Try again shortly.");
    const controller = new AbortController();
    this.operations.add(controller);
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs); timer.unref();
    try { return await work(controller.signal); }
    catch (error) {
      if (controller.signal.aborted) throw failure("ASSET_STORAGE_TIMEOUT", "The object storage operation was interrupted or timed out. Try again.");
      if (error instanceof ApiError) throw error;
      // SDK errors can contain endpoints, request headers and provider responses.
      throw failure(code, message);
    } finally { clearTimeout(timer); this.operations.delete(controller); }
  }
  private async read(ref: StoredObject, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: ref.key }), { abortSignal: signal });
    if (!result.Body) throw failure("ASSET_READ_FAILED", "Object storage returned no asset content.");
    const reader = result.Body.transformToWebStream().getReader();
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      if (result.$metadata.httpStatusCode !== 200 || result.ContentLength !== ref.bytes || result.ContentEncoding && result.ContentEncoding !== "identity") throw failure("ASSET_INTEGRITY_ERROR", "The saved object does not match its registered content.");
      const chunks: Uint8Array[] = []; const hash = createHash("sha256"); let bytes = 0;
      for (;;) {
        const chunk = await reader.read(); signal.throwIfAborted();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes || bytes > ref.bytes) throw failure("ASSET_INTEGRITY_ERROR", "The saved object exceeds its registered size.");
        chunks.push(chunk.value); hash.update(chunk.value);
      }
      if (bytes !== ref.bytes || hash.digest("hex") !== ref.sha256) throw failure("ASSET_INTEGRITY_ERROR", "The saved object does not match its registered content.");
      return Buffer.concat(chunks, bytes);
    } finally {
      signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {}); reader.releaseLock();
    }
  }
  async put(location: string, data: Uint8Array, mimeType: string): Promise<StoredObject> {
    if (!LOCATION.test(location)) throw failure("INVALID_ASSET_KEY", "Use a valid input or generated-output location.", 400);
    if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > MAX_BYTES) throw failure("ASSET_TOO_LARGE", "Save an asset between 1 byte and 64 MiB.", 413);
    if (typeof mimeType !== "string" || mimeType.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/.test(mimeType)) throw failure("INVALID_ASSET_TYPE", "Use a valid asset media type.", 400);
    // Own the buffer while requests are pending; callers cannot change hashed bytes.
    const bytes = Buffer.from(data); const sha256 = digest(bytes);
    const ref: StoredObject = { backend: "s3", storeId: this.id, key: `${this.config.prefix}/${location}/${sha256}`, sha256, bytes: bytes.length };
    return this.operation("ASSET_WRITE_FAILED", "The asset could not be saved to object storage. Try again.", async signal => {
      try { await this.read(ref, bytes.length, signal); return ref; }
      catch (error) { if (!missing(error)) throw error; }
      try {
        const response = await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: ref.key, Body: bytes,
          ContentType: mimeType, ContentLength: bytes.length, Metadata: { sha256 }, IfNoneMatch: "*" }), { abortSignal: signal });
        if (response.$metadata.httpStatusCode !== 200) throw failure("ASSET_WRITE_FAILED", "Object storage did not confirm the asset write.");
      } catch (writeError) {
        // A concurrent creator, or a committed write with a lost acknowledgement,
        // is successful only when the stored bytes are actually identical.
        try { await this.read(ref, bytes.length, signal); return ref; }
        catch { throw writeError; }
      }
      await this.read(ref, bytes.length, signal);
      return ref;
    });
  }
  async get(ref: StoredObject, maxBytes: number): Promise<Buffer> {
    this.reference(ref, maxBytes);
    return this.operation("ASSET_READ_FAILED", "The asset could not be read from object storage. Try again.", signal => this.read(ref, maxBytes, signal));
  }
  async delete(ref: StoredObject): Promise<void> {
    this.reference(ref);
    return this.operation("ASSET_DELETE_FAILED", "The asset could not be deleted from object storage. Try again.", async signal => {
      try {
        const response = await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: ref.key }), { abortSignal: signal });
        if (response.$metadata.httpStatusCode !== 204) throw failure("ASSET_DELETE_FAILED", "Object storage did not confirm the asset deletion.");
      } catch (error) { if (!missing(error)) throw error; }
    });
  }
  close() { this.closed = true; for (const operation of this.operations) operation.abort(); this.client.destroy(); }
}
