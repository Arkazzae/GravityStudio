import { randomUUID } from "node:crypto";
import { isRelativeFile } from "./catalog.ts";
import { canonicalJson, validateInputImage, verifySnapshot } from "./compiler.ts";
import { comboOptions } from "./discovery.ts";
import type { ComfyDiscovery, NodeInfo } from "./discovery.ts";
import { InferenceError } from "./types.ts";
import type { ExecutionSnapshot, InputImage, ModelFolder } from "./types.ts";

export interface OutputReference {
  node: string;
  field: "images";
  filename: string;
  subfolder: string;
  type: "output";
}

export type ComfyJobState = "missing" | "queued" | "running" | "succeeded" | "failed";
export interface ComfyJobStatus {
  promptId: string;
  state: ComfyJobState;
  outputs: OutputReference[];
  error?: string;
}
export interface ComfyProgress {
  type: "executing" | "progress" | "completed" | "error" | "disconnected";
  node?: string;
  /** Actual node-level sampling counts from ComfyUI, never an estimated whole-job percent. */
  value?: number;
  max?: number;
}

export interface ComfySystemStats {
  system: { ram_total?: number; ram_free?: number; comfyui_version?: string };
  devices: { name?: string; type?: string; index?: number; vram_total?: number; vram_free?: number; torch_vram_total?: number; torch_vram_free?: number }[];
  sampledAt: string;
}

type History = { outputs?: Record<string, Record<string, unknown>>; status?: { status_str?: string; completed?: boolean; messages?: unknown[] }; prompt?: unknown[] };
type Queue = { queue_running: unknown[][]; queue_pending: unknown[][] };
const MODEL_FOLDERS: ModelFolder[] = ["checkpoints", "diffusion_models", "text_encoders", "vae"];
const LOADERS: Record<ModelFolder, [string, string]> = {
  checkpoints: ["CheckpointLoaderSimple", "ckpt_name"], diffusion_models: ["UNETLoader", "unet_name"],
  text_encoders: ["CLIPLoader", "clip_name"], vae: ["VAELoader", "vae_name"],
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function assertId(id: string): void {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new InferenceError("INVALID_INPUT", "Invalid worker prompt ID.");
}

class ComfyHttpError extends InferenceError {
  readonly status: number;
  constructor(status: number, path: string) {
    super("COMFY_HTTP_ERROR", `ComfyUI returned HTTP ${status} for ${path.split("?")[0]}.`);
    this.status = status;
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel();
    throw new InferenceError("RESPONSE_TOO_LARGE", "The worker response exceeds the configured size limit.");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new InferenceError("RESPONSE_TOO_LARGE", "The worker response exceeds the configured size limit."); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

function imageMediaType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 16 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return undefined;
}

function outputReferences(history: History, snapshot?: ExecutionSnapshot): OutputReference[] {
  const allowed = snapshot?.outputs ?? Object.keys(history.outputs ?? {}).map(node => ({ node, field: "images" as const }));
  const outputs: OutputReference[] = [];
  for (const { node, field } of allowed) {
    const files = history.outputs?.[node]?.[field];
    if (files === undefined) continue;
    if (!Array.isArray(files)) throw new InferenceError("INVALID_OUTPUT", "The worker returned invalid image output references.");
    for (const file of files) {
      if (!object(file) || file.type !== "output" || !isRelativeFile(file.filename) || file.filename.includes("/") || !(file.subfolder === undefined || file.subfolder === "" || isRelativeFile(file.subfolder))) {
        throw new InferenceError("INVALID_OUTPUT", "The worker returned an unsafe output file reference.");
      }
      outputs.push({ node, field, filename: file.filename, subfolder: String(file.subfolder ?? ""), type: "output" });
      if (outputs.length > 16) throw new InferenceError("INVALID_OUTPUT", "The worker returned too many image outputs.");
    }
  }
  return outputs;
}

function terminalStatus(promptId: string, history: History, snapshot?: ExecutionSnapshot): ComfyJobStatus {
  if (history.status?.status_str === "error" || history.status?.messages?.some(message => Array.isArray(message) && ["execution_error", "execution_interrupted"].includes(String(message[0])))) {
    return { promptId, state: "failed", outputs: [], error: "ComfyUI could not execute the workflow." };
  }
  const outputs = outputReferences(history, snapshot);
  if (history.status?.completed === false) return { promptId, state: "running", outputs: [] };
  if (!outputs.length) return { promptId, state: "failed", outputs: [], error: "The workflow finished without saved images." };
  return { promptId, state: "succeeded", outputs };
}

export class ComfyClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  #submitting = new Map<string, { hash: string; task: Promise<{ promptId: string; reconciled: boolean }> }>();

  constructor(baseUrl: string, options: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new InferenceError("INVALID_ENDPOINT", "Use a ComfyUI HTTP endpoint without embedded credentials, query or fragment.");
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000 || !Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 1 || this.maxOutputBytes > 512 * 1024 * 1024) throw new InferenceError("INVALID_CONFIG", "Invalid worker request limits.");
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, { ...init, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) { await response.body?.cancel(); throw new ComfyHttpError(response.status, path); }
      return response;
    } catch (error) {
      if (error instanceof InferenceError) throw error;
      throw new InferenceError("COMFY_UNREACHABLE", "Could not reach ComfyUI within the request timeout.", { cause: error });
    }
  }

  async #json(path: string, body?: unknown, maxBytes = 16 * 1024 * 1024): Promise<unknown> {
    const response = await this.#request(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const bytes = await readBounded(response, maxBytes);
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new InferenceError("INVALID_WORKER_RESPONSE", "ComfyUI returned invalid JSON."); }
  }

  async systemStats(): Promise<ComfySystemStats> {
    const result = await this.#json("/system_stats", undefined, 1024 * 1024);
    if (!object(result) || !object(result.system) || !Array.isArray(result.devices) || result.devices.length > 64 || !result.devices.every(object)) throw new InferenceError("INVALID_WORKER_RESPONSE", "The endpoint did not return ComfyUI system statistics.");
    const fields = (source: Record<string, unknown>, numbers: string[], strings: string[]) => {
      const result: Record<string, number | string> = {};
      for (const key of numbers) {
        const value = source[key];
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new InferenceError("INVALID_WORKER_RESPONSE", "ComfyUI returned an invalid memory measurement.");
        result[key] = value;
      }
      for (const key of strings) if (typeof source[key] === "string") result[key] = source[key].slice(0, 256);
      return result;
    };
    return {
      system: fields(result.system, ["ram_total", "ram_free"], ["comfyui_version"]),
      devices: result.devices.map(device => fields(device, ["index", "vram_total", "vram_free", "torch_vram_total", "torch_vram_free"], ["name", "type"])),
      sampledAt: new Date().toISOString(),
    };
  }

  async health(): Promise<{ healthy: boolean; version?: string; error?: string }> {
    try {
      const result = await this.systemStats();
      return { healthy: true, ...(result.system.comfyui_version ? { version: result.system.comfyui_version } : {}) };
    } catch (error) { return { healthy: false, error: error instanceof InferenceError ? error.message : "ComfyUI is unavailable." }; }
  }

  async discover(): Promise<ComfyDiscovery> {
    const info = await this.#json("/object_info");
    if (!object(info) || !Object.values(info).every(object)) throw new InferenceError("INVALID_WORKER_RESPONSE", "ComfyUI returned invalid node definitions.");
    const objectInfo = info as Record<string, NodeInfo>;
    const discovery: ComfyDiscovery = { objectInfo, models: {}, modelSources: {} };
    await Promise.all(MODEL_FOLDERS.map(async folder => {
      try {
        const files = await this.#json(`/models/${folder}`);
        if (!Array.isArray(files) || !files.every(file => typeof file === "string")) throw new InferenceError("INVALID_WORKER_RESPONSE", "ComfyUI returned an invalid model inventory.");
        discovery.models[folder] = files.filter(isRelativeFile);
        discovery.modelSources[folder] = "models-api";
      } catch (error) {
        if (!(error instanceof ComfyHttpError) || error.status !== 404) throw error;
        const [loader, input] = LOADERS[folder];
        discovery.models[folder] = (comboOptions(objectInfo[loader]?.input?.required?.[input]) ?? []).filter(isRelativeFile);
        discovery.modelSources[folder] = "loader-schema";
      }
    }));
    return discovery;
  }

  async #queue(): Promise<Queue> {
    const queue = await this.#json("/queue");
    if (!object(queue) || !Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending) || ![...queue.queue_running, ...queue.queue_pending].every(entry => Array.isArray(entry) && typeof entry[1] === "string")) throw new InferenceError("INVALID_WORKER_RESPONSE", "ComfyUI returned an invalid queue.");
    return queue as Queue;
  }

  async #history(promptId: string): Promise<History | undefined> {
    assertId(promptId);
    const histories = await this.#json(`/history/${encodeURIComponent(promptId)}`);
    if (!object(histories)) throw new InferenceError("INVALID_WORKER_RESPONSE", "ComfyUI returned invalid history.");
    const history = histories[promptId];
    if (history !== undefined && !object(history)) throw new InferenceError("INVALID_WORKER_RESPONSE", "ComfyUI returned an invalid job record.");
    return history as History | undefined;
  }

  async inspect(promptId: string, snapshot?: ExecutionSnapshot): Promise<ComfyJobStatus> {
    if (snapshot) verifySnapshot(snapshot);
    const history = await this.#history(promptId);
    if (history) return terminalStatus(promptId, history, snapshot);
    const queue = await this.#queue();
    if (queue.queue_running.some(entry => entry[1] === promptId)) return { promptId, state: "running", outputs: [] };
    if (queue.queue_pending.some(entry => entry[1] === promptId)) return { promptId, state: "queued", outputs: [] };
    // A job can complete between the history and queue requests.
    const completed = await this.#history(promptId);
    return completed ? terminalStatus(promptId, completed, snapshot) : { promptId, state: "missing", outputs: [] };
  }

  async findJob(jobId: string, expectedHash?: string): Promise<{ promptId: string; state: Exclude<ComfyJobState, "missing"> } | null> {
    if (!UUID.test(jobId)) throw new InferenceError("INVALID_INPUT", "Use a UUID for the durable job ID.");
    const verifyIdentity = (entry: unknown[] | undefined) => {
      const metadata = entry?.[3];
      if (expectedHash && object(metadata) && typeof metadata.grav_snapshot_hash === "string" && metadata.grav_snapshot_hash !== expectedHash) throw new InferenceError("JOB_ID_CONFLICT", "This durable job ID belongs to a different execution snapshot.");
    };
    const direct = await this.#history(jobId);
    if (direct) { verifyIdentity(direct.prompt); return { promptId: jobId, state: terminalStatus(jobId, direct).state as Exclude<ComfyJobState, "missing"> }; }
    const matches = (entry: unknown[]) => entry[1] === jobId || object(entry[3]) && (entry[3].grav_job_id === jobId || entry[3].client_id === jobId);
    const queue = await this.#queue();
    for (const [entries, state] of [[queue.queue_running, "running"], [queue.queue_pending, "queued"]] as const) {
      const entry = entries.find(matches);
      if (entry) { verifyIdentity(entry); const promptId = String(entry[1]); assertId(promptId); return { promptId, state }; }
    }
    // Older ComfyUI versions assign their own prompt ID. Metadata survives in history.
    const histories = await this.#json("/history?max_items=1000");
    if (!object(histories)) throw new InferenceError("INVALID_WORKER_RESPONSE", "ComfyUI returned invalid history.");
    for (const [promptId, history] of Object.entries(histories)) {
      if (object(history) && (promptId === jobId || Array.isArray(history.prompt) && matches(history.prompt))) {
        verifyIdentity(Array.isArray(history.prompt) ? history.prompt : undefined);
        assertId(promptId);
        return { promptId, state: terminalStatus(promptId, history as History).state as Exclude<ComfyJobState, "missing"> };
      }
    }
    return null;
  }

  /** The durable coordinator must serialize submissions and persist submitting before this call. */
  async submit(snapshot: ExecutionSnapshot, options: { jobId: string }): Promise<{ promptId: string; reconciled: boolean }> {
    verifySnapshot(snapshot);
    if (!UUID.test(options.jobId)) throw new InferenceError("INVALID_INPUT", "Use a UUID for the durable job ID.");
    const pending = this.#submitting.get(options.jobId);
    if (pending) {
      if (pending.hash !== snapshot.hash) throw new InferenceError("JOB_ID_CONFLICT", "This durable job ID belongs to a different execution snapshot.");
      return pending.task;
    }
    const task = this.#submit(structuredClone(snapshot), options.jobId);
    this.#submitting.set(options.jobId, { hash: snapshot.hash, task });
    try { return await task; } finally { this.#submitting.delete(options.jobId); }
  }

  async #submit(snapshot: ExecutionSnapshot, jobId: string): Promise<{ promptId: string; reconciled: boolean }> {
    const existing = await this.findJob(jobId, snapshot.hash);
    if (existing) return { promptId: existing.promptId, reconciled: true };
    try {
      const result = await this.#json("/prompt", { prompt: snapshot.graph, prompt_id: jobId, client_id: jobId, extra_data: { grav_job_id: jobId, grav_snapshot_hash: snapshot.hash } });
      if (!object(result) || typeof result.prompt_id !== "string") throw new InferenceError("INVALID_WORKER_RESPONSE", "ComfyUI did not acknowledge the prompt ID.");
      assertId(result.prompt_id);
      return { promptId: result.prompt_id, reconciled: false };
    } catch (error) {
      if (error instanceof ComfyHttpError && error.status >= 400 && error.status < 500) throw new InferenceError("WORKFLOW_REJECTED", "ComfyUI rejected the workflow. Check the installed nodes, model files and parameters.", { cause: error });
      try { const recovered = await this.findJob(jobId, snapshot.hash); if (recovered) return { promptId: recovered.promptId, reconciled: true }; } catch { /* The coordinator preserves the uncertain state for later reconciliation. */ }
      throw new InferenceError("SUBMISSION_UNCERTAIN", "ComfyUI may have accepted this job. Reconcile its durable ID before any new submission.", { cause: error });
    }
  }

  async uploadImage(bytes: Uint8Array, options: { filename: string; mediaType: string; jobId?: string }): Promise<InputImage> {
    const mediaType = imageMediaType(bytes);
    if (bytes.byteLength > 16 * 1024 * 1024 || !mediaType || mediaType !== options.mediaType) throw new InferenceError("INVALID_IMAGE", "Upload a PNG, JPEG or WebP image of at most 16 MiB.");
    if (!isRelativeFile(options.filename) || options.filename.includes("/") || !/\.(png|jpe?g|webp)$/i.test(options.filename)) throw new InferenceError("INVALID_IMAGE", "Use a plain image filename.");
    const jobId = options.jobId ?? randomUUID();
    if (!UUID.test(jobId)) throw new InferenceError("INVALID_INPUT", "Use a UUID for the upload scope.");
    const subfolder = `grav/${jobId}`;
    const form = new FormData();
    form.set("image", new Blob([new Uint8Array(bytes)], { type: mediaType }), options.filename);
    form.set("type", "input"); form.set("subfolder", subfolder); form.set("overwrite", "false");
    const response = await this.#request("/upload/image", { method: "POST", body: form });
    let uploaded: unknown;
    try { uploaded = JSON.parse(new TextDecoder().decode(await readBounded(response, 64 * 1024))); }
    catch { throw new InferenceError("INVALID_WORKER_RESPONSE", "ComfyUI did not acknowledge the uploaded image."); }
    if (!object(uploaded) || uploaded.subfolder !== subfolder || uploaded.type !== "input" || typeof uploaded.name !== "string") throw new InferenceError("INVALID_WORKER_RESPONSE", "ComfyUI saved the image outside the requested input scope.");
    const input: InputImage = { filename: uploaded.name, subfolder, type: "input" };
    validateInputImage(input);
    return input;
  }

  async fetchOutput(promptId: string, reference: OutputReference, snapshot?: ExecutionSnapshot): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const job = await this.inspect(promptId, snapshot);
    if (job.state !== "succeeded" || !job.outputs.some(output => canonicalJson(output) === canonicalJson(reference))) throw new InferenceError("INVALID_OUTPUT", "This file is not a completed output of the requested job.");
    const query = new URLSearchParams({ filename: reference.filename, subfolder: reference.subfolder, type: "output" });
    const response = await this.#request(`/view?${query}`);
    const bytes = await readBounded(response, this.maxOutputBytes);
    const mediaType = imageMediaType(bytes);
    if (!mediaType) throw new InferenceError("INVALID_OUTPUT", "The worker returned an unsupported image format.");
    return { bytes, mediaType };
  }

  async freeIfIdle(): Promise<{ released: boolean }> {
    const queue = await this.#queue();
    if (queue.queue_running.length || queue.queue_pending.length) return { released: false };
    const response = await this.#request("/free", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) });
    await response.body?.cancel();
    return { released: true };
  }

  /** HTTP history remains authoritative; reconnecting may miss intermediate progress. */
  watchProgress(jobId: string, callback: (event: ComfyProgress) => void): { close(): void } {
    if (!UUID.test(jobId)) throw new InferenceError("INVALID_INPUT", "Use the durable job UUID as the WebSocket client ID.");
    const url = new URL(`${this.baseUrl}/ws`); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.searchParams.set("clientId", jobId);
    const socket = new WebSocket(url);
    let closed = false;
    const emit = (event: ComfyProgress) => { if (!closed) callback(event); };
    const timer = setTimeout(() => { if (socket.readyState === WebSocket.CONNECTING) socket.close(); }, this.timeoutMs);
    timer.unref();
    socket.addEventListener("open", () => clearTimeout(timer));
    socket.addEventListener("message", event => {
      if (typeof event.data !== "string" || event.data.length > 64 * 1024) return;
      let message: unknown; try { message = JSON.parse(event.data); } catch { return; }
      if (!object(message) || !object(message.data)) return;
      const data = message.data;
      if (message.type === "progress" && typeof data.value === "number" && Number.isFinite(data.value) && typeof data.max === "number" && Number.isFinite(data.max) && data.max > 0 && data.value >= 0 && data.value <= data.max) {
        emit({ type: "progress", value: data.value, max: data.max, ...(typeof data.node === "string" ? { node: data.node } : {}) });
      } else if (message.type === "executing" && typeof data.node === "string") emit({ type: "executing", node: data.node });
      else if (message.type === "execution_success" || message.type === "executing" && data.node === null) emit({ type: "completed" });
      else if (["execution_error", "execution_interrupted"].includes(String(message.type))) emit({ type: "error" });
    });
    socket.addEventListener("error", () => { clearTimeout(timer); emit({ type: "disconnected" }); });
    socket.addEventListener("close", () => { clearTimeout(timer); emit({ type: "disconnected" }); });
    return { close() { closed = true; clearTimeout(timer); socket.close(); } };
  }
}
