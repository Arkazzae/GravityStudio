import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, realpath, statfs, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ApiError } from "../../packages/contracts/index.ts";
import type { Store } from "./store.ts";

export interface LocalTextModel {
  id: string; name: string; quantization: "Q8_0"; sizeBytes: number; source: string; license: string;
  contextTokens: number; filename: string; downloadUrl: string; sha256: string;
}
export const LOCAL_TEXT_MODEL: Readonly<LocalTextModel> = Object.freeze({
  id: "mimo-v2.6-distill-qwen-9b", name: "MiMo V2.6 Distill Qwen 9B", quantization: "Q8_0",
  sizeBytes: 9_527_498_048, source: "https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Distill-Qwen-9B", license: "MIT",
  contextTokens: 8192, filename: "MiMo-V2.6-Distill-Qwen-9B-Q8_0.gguf",
  downloadUrl: "https://huggingface.co/ggml-org/MiMo-V2.6-Distill-Qwen-9B-GGUF/resolve/81baddc39bc48924a88e87b8d31aceb03058e559/MiMo-V2.6-Distill-Qwen-9B-Q8_0.gguf",
  sha256: "de6dae10334e088876358ef9f574835bb3b401ea2ecf5d6a9473f37894df6b73",
});

const GiB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;
// Keep the same explicit Hugging Face storage hosts as the image model downloader.
const downloadHosts = new Set([
  "huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs.hf.co", "cdn-lfs-us-1.hf.co", "cdn-lfs-eu-1.hf.co",
  "cas-bridge.xethub.hf.co", "cas-server.xethub.hf.co", "cas-server.xethub-eu.hf.co",
  "transfer.xethub.hf.co", "transfer.xethub-eu.hf.co", "us.aws.cdn.hf.co", "us.gcp.cdn.hf.co",
]);
const failure = (code: string, message: string, status = 400) => new ApiError(status, `TEXT_MODEL_${code}`, message);
const conflict = () => failure("FILE_CONFLICT", "An existing text model file does not match this model. It has been left unchanged.", 409);
const stamp = (file: BigIntStats) => `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
function active(signal: AbortSignal): void {
  if (signal.aborted) throw failure("CANCELLED", "The text model download was cancelled.", 499);
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // Attach a handler even when cancellation happened synchronously in the producer.
  void promise.catch(() => {});
  active(signal);
  let listener: () => void = () => {};
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      listener = () => reject(failure("CANCELLED", "The text model download was cancelled.", 499));
      signal.addEventListener("abort", listener, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", listener); }
}
function checkUrl(url: URL): void {
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !downloadHosts.has(url.hostname)) throw failure("UNSAFE_REDIRECT", "Hugging Face redirected this file to an unsupported download host.");
}
function validHeader(header: Uint8Array): boolean {
  const bytes = Buffer.from(header);
  return bytes.length >= 24 && bytes.toString("ascii", 0, 4) === "GGUF" && [2, 3].includes(bytes.readUInt32LE(4)) && bytes.readBigUInt64LE(8) > 0n;
}

export interface TextModelProgress { receivedBytes: number; totalBytes: number }
interface Options {
  fetch?: typeof fetch;
  huggingFaceToken?: () => string | undefined;
  model?: Readonly<LocalTextModel>;
  availableBytes?: (directory: string) => Promise<number>;
  /** Inactivity timeout, including waiting for response headers. */
  timeoutMs?: number;
  totalTimeoutMs?: number;
}

/** Immutable catalog artifact. No settings mutations or model activation happen here. */
export class TextModelFiles {
  readonly path: string;
  private storageDirectory: string;
  private model: Readonly<LocalTextModel>;
  private fetcher: typeof fetch;
  private token: () => string | undefined;
  private availableBytes: (directory: string) => Promise<number>;
  private timeoutMs: number;
  private totalTimeoutMs: number;
  private verifiedStamp?: string;
  private downloading = false;
  private verification?: Promise<boolean>;

  constructor(store: Store, options: Options = {}) {
    this.model = Object.freeze({ ...(options.model ?? LOCAL_TEXT_MODEL) });
    const source = new URL(this.model.downloadUrl);
    checkUrl(source);
    if (source.hostname !== "huggingface.co" || source.search || !/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/resolve\/[a-f0-9]{40}\/[a-zA-Z0-9_.-]+\.gguf$/.test(source.pathname) || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.gguf$/.test(this.model.filename) || !/^[a-f0-9]{64}$/.test(this.model.sha256) || !Number.isSafeInteger(this.model.sizeBytes) || this.model.sizeBytes < 24 || this.model.sizeBytes > 128 * GiB) throw new TypeError("Text model artifacts require a pinned Hugging Face GGUF URL, filename, size and SHA-256.");
    this.storageDirectory = resolve(store.directory);
    this.path = join(this.storageDirectory, "models", "text", this.model.filename);
    this.fetcher = options.fetch ?? fetch;
    this.token = options.huggingFaceToken ?? (() => undefined);
    this.availableBytes = options.availableBytes ?? (async directory => { const fs = await statfs(directory); return fs.bavail * fs.bsize; });
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.totalTimeoutMs = options.totalTimeoutMs ?? DAY;
    for (const value of [this.timeoutMs, this.totalTimeoutMs]) if (!Number.isSafeInteger(value) || value <= 0 || value > DAY) throw new TypeError("Text model download timeouts must be positive milliseconds, up to 24 hours.");
  }

  private async directory(create = false): Promise<boolean> {
    try {
      let directory = this.storageDirectory;
      for (const part of ["", "models", "text"]) {
        if (part) {
          directory = join(directory, part);
          if (create) {
            try { await mkdir(directory, { mode: 0o700 }); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
          }
        }
        if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) throw failure("UNSAFE_DIRECTORY", "The managed text model directory cannot contain symbolic links.", 409);
      }
      return true;
    } catch (error) { if (missing(error)) return false; throw error; }
  }

  private async verified(signal?: AbortSignal): Promise<boolean> {
    if (!await this.directory()) return false;
    let before: BigIntStats;
    try { before = await lstat(this.path, { bigint: true }); }
    catch (error) { if (missing(error)) return false; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(this.model.sizeBytes)) throw conflict();
    const beforeStamp = stamp(before);
    if (this.verifiedStamp === beforeStamp) return true;
    const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (stamp(await file.stat({ bigint: true })) !== beforeStamp) throw conflict();
      const header = Buffer.alloc(24);
      if ((await file.read(header, 0, header.length, 0)).bytesRead !== header.length || !validHeader(header)) throw conflict();
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ start: 0, autoClose: false, signal })) hash.update(chunk);
      if (hash.digest("hex") !== this.model.sha256 || stamp(await file.stat({ bigint: true })) !== beforeStamp || stamp(await lstat(this.path, { bigint: true })) !== beforeStamp) throw conflict();
      this.verifiedStamp = beforeStamp;
      return true;
    } finally { await file.close(); }
  }

  installed(): Promise<boolean> {
    if (!this.verification) {
      this.verification = this.verified().catch(error => {
        this.verifiedStamp = undefined;
        if (error instanceof ApiError && ["TEXT_MODEL_FILE_CONFLICT", "TEXT_MODEL_UNSAFE_DIRECTORY"].includes(error.code)) return false;
        throw failure("FILE_UNAVAILABLE", "The text model file could not be checked. Check its storage and permissions.", 503);
      }).finally(() => { this.verification = undefined; });
    }
    return this.verification;
  }

  private async request(signal: AbortSignal): Promise<Response> {
    let url = new URL(this.model.downloadUrl);
    const token = this.token() ?? process.env.HF_TOKEN;
    for (let redirects = 0; redirects < 8; redirects++) {
      active(signal); checkUrl(url);
      const headers: Record<string, string> = { "Accept-Encoding": "identity" };
      if (url.hostname === "huggingface.co" && token) headers.Authorization = `Bearer ${token}`;
      let response: Response;
      try {
        const pending = this.fetcher(url, { headers, redirect: "manual", signal });
        void pending.then(result => { if (signal.aborted) void result.body?.cancel().catch(() => {}); }, () => {});
        response = await abortable(pending, signal);
      } catch { active(signal); throw failure("DOWNLOAD_UNAVAILABLE", "Could not reach Hugging Face. Check the connection and retry.", 502); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (!location) throw failure("INVALID_REDIRECT", "The model download returned an incomplete redirect.", 502);
        try { url = new URL(location, url); } catch { throw failure("INVALID_REDIRECT", "The model download returned an invalid redirect.", 502); }
        continue;
      }
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        if ([401, 403].includes(response.status)) throw failure("ACCESS_REQUIRED", "Hugging Face denied access. Check the model license and your Hugging Face token in Settings → Integrations.");
        throw failure("DOWNLOAD_HTTP", "Hugging Face could not return the complete model file. Retry the download.", 502);
      }
      return response;
    }
    throw failure("REDIRECT_LIMIT", "The model download returned too many redirects.", 502);
  }

  async download(external: AbortSignal, onProgress: (progress: TextModelProgress) => void): Promise<void> {
    if (this.downloading) throw failure("DOWNLOAD_BUSY", "This text model is already being downloaded.", 409);
    active(external); this.downloading = true;
    const controller = new AbortController();
    const signal = AbortSignal.any([external, controller.signal]);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let totalTimeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const expire = () => { timedOut = true; controller.abort(); };
    const touch = () => { clearTimeout(timeout); timeout = setTimeout(expire, this.timeoutMs); };
    const partial = `${this.path}.${randomUUID()}.partial`;
    let ownsPartial = false;
    try {
      await this.directory(true);
      if (await this.verified(signal)) { active(signal); onProgress({ receivedBytes: this.model.sizeBytes, totalBytes: this.model.sizeBytes }); return; }
      active(signal);
      const directory = dirname(this.path);
      const space = async (remaining: number) => {
        const available = await this.availableBytes(directory);
        if (!Number.isFinite(available) || available < remaining + GiB) throw failure("DISK_SPACE", "There is not enough free disk space for the text model plus 1 GiB of reserve.");
      };
      await space(this.model.sizeBytes);
      totalTimeout = setTimeout(expire, this.totalTimeoutMs); touch();
      const response = await this.request(signal);
      const length = response.headers.get("content-length");
      const encoding = response.headers.get("content-encoding");
      if (!response.body || length !== null && (!/^\d+$/.test(length) || Number(length) !== this.model.sizeBytes) || encoding && encoding !== "identity") {
        void response.body?.cancel().catch(() => {});
        throw failure("INVALID_SIZE", "The model server returned an unexpected file size or encoding.", 502);
      }
      let file;
      try { file = await open(partial, "wx", 0o600); ownsPartial = true; }
      catch (error) { void response.body.cancel().catch(() => {}); throw error; }
      const reader = response.body.getReader();
      const hash = createHash("sha256");
      let received = 0, reportedAt = 0, diskCheckAt = 256 * 1024 ** 2;
      let header = Buffer.alloc(0);
      try {
        onProgress({ receivedBytes: 0, totalBytes: this.model.sizeBytes });
        while (true) {
          let next: ReadableStreamReadResult<Uint8Array>;
          try { next = await abortable(reader.read(), signal); }
          catch { active(signal); throw failure("DOWNLOAD_UNAVAILABLE", "The model connection was interrupted. Retry the download.", 502); }
          if (next.done) break;
          active(signal);
          if (!next.value.byteLength) continue;
          touch(); received += next.value.byteLength;
          if (received > this.model.sizeBytes) throw failure("INVALID_SIZE", "The model download exceeded its pinned file size.", 502);
          if (header.length < 24) {
            header = Buffer.concat([header, next.value.subarray(0, 24 - header.length)]);
            if (header.length === 24 && !validHeader(header)) throw failure("INVALID_GGUF", "The downloaded file is not a supported GGUF model.", 502);
          }
          hash.update(next.value);
          await file.writeFile(next.value);
          active(signal);
          if (received >= diskCheckAt) { await space(this.model.sizeBytes - received); diskCheckAt = received + 256 * 1024 ** 2; }
          if (Date.now() - reportedAt >= 250) { onProgress({ receivedBytes: received, totalBytes: this.model.sizeBytes }); reportedAt = Date.now(); }
        }
        active(signal);
        if (received !== this.model.sizeBytes) throw failure("INCOMPLETE", "The text model download ended before the complete file arrived.", 502);
        if (!validHeader(header)) throw failure("INVALID_GGUF", "The downloaded file is not a supported GGUF model.", 502);
        if (hash.digest("hex") !== this.model.sha256) throw failure("CHECKSUM_MISMATCH", "The downloaded text model does not match its SHA-256 checksum. Retry the download.", 502);
        await file.sync();
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); await file.close(); }
      active(signal); await this.directory(); active(signal);
      // Hard-link publication fails if another process created the destination; it never overwrites it.
      await link(partial, this.path);
      await unlink(partial); ownsPartial = false;
      this.verifiedStamp = stamp(await lstat(this.path, { bigint: true }));
      onProgress({ receivedBytes: this.model.sizeBytes, totalBytes: this.model.sizeBytes });
    } catch (error) {
      if (timedOut) throw failure("DOWNLOAD_TIMEOUT", "The text model download stopped responding or exceeded its time limit. Retry the download.", 504);
      active(signal);
      if (error instanceof ApiError) throw error;
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") throw conflict();
      if ((error as NodeJS.ErrnoException)?.code === "ENOSPC") throw failure("DISK_SPACE", "Storage filled up while downloading the text model. Free disk space and retry.");
      throw failure("DOWNLOAD_FAILED", "The text model download failed. Check the connection, storage and permissions, then retry.", 502);
    } finally {
      clearTimeout(timeout); clearTimeout(totalTimeout);
      try { if (ownsPartial) await unlink(partial); }
      catch (error) { if (!missing(error)) throw failure("CLEANUP_FAILED", "The interrupted text model download could not be removed. Check storage permissions before retrying.", 503); }
      finally { this.downloading = false; }
    }
  }
}
