import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { ApiError } from "../../packages/contracts/index.ts";
import type { PromptRefinementResult, TextModels, TextProviderId, TextSettings } from "../../packages/contracts/text.ts";
import { cancelled, discoverTextModels, generateRefinement, validModelId, type TextConnection } from "../../packages/text/providers.ts";
import type { CredentialVault } from "./credentials.ts";
import type { Store } from "./store.ts";
import { modelRegistry } from "./registry.ts";
import { buildRefinementPrompt, parseRefinementResult } from "./prompt-refinement.ts";

const metadataKey = "text-settings";
const credentialId = "text-openai-compatible";
interface SavedSettings { version: 1; revision: number; baseUrl: string; assistant: TextSettings["assistant"] }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const changed = () => new ApiError(409, "TEXT_SETTINGS_CHANGED", "Text settings changed. Reload them and try again.");
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new ApiError(400, "INVALID_TEXT_SETTINGS", message); }
function providerId(value: unknown): TextProviderId { check(value === "gemini" || value === "openai-compatible", "Choose Gemini or an OpenAI-compatible connection."); return value; }
function revision(value: unknown): asserts value is number { check(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER, "Reload the current text settings before saving."); }

/** Only the owner can configure this destination; generation requests never supply URLs. */
export function textBaseUrl(value: unknown): string {
  check(typeof value === "string" && value.length <= 2048 && !/[\x00-\x20\x7f\\]/.test(value), "Enter an HTTP or HTTPS API base URL, including /v1 when required.");
  if (value === "") return "";
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(400, "INVALID_TEXT_SETTINGS", "Enter a complete HTTP or HTTPS API base URL."); }
  check(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, "The API address cannot contain credentials, a query or a fragment.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  check(!["0.0.0.0", "::", "169.254.169.254", "100.100.100.200", "fd00:ec2::254", "metadata.google.internal", "metadata.goog"].includes(hostname) && !hostname.endsWith(".internal.google") && !hostname.startsWith("169.254.") && !(isIP(hostname) === 6 && (/^fe[89ab]/.test(hostname) || hostname.startsWith("ff"))), "Use a reachable model server address, not a metadata, link-local or multicast address.");
  if (isIP(hostname) === 4) check(Number(hostname.split(".")[0]) < 224 && !hostname.startsWith("0."), "Use a reachable model server address.");
  if (hostname.startsWith("::ffff:")) {
    const parts = hostname.slice(7).split(":");
    if (parts.length === 2) textBaseUrl(`${url.protocol}//${parseInt(parts[0], 16) >>> 8}.${parseInt(parts[0], 16) & 255}.${parseInt(parts[1], 16) >>> 8}.${parseInt(parts[1], 16) & 255}`);
  }
  check(!/%(?:2f|5c|00)/i.test(url.pathname), "Use an API base URL without encoded path separators.");
  return url.toString().replace(/\/+$/, "");
}

export class TextService {
  private store: Store;
  private credentials: CredentialVault;
  private fetcher: typeof fetch;
  private timeoutMs: number;
  private closed = false;
  private refining = false;
  private operations = new Map<AbortController, Promise<unknown>>();
  private discovering = new Set<TextProviderId>();
  private cache = new Map<TextProviderId, { identity: string; at: number; result: TextModels }>();
  constructor(store: Store, credentials: CredentialVault, options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.store = store; this.credentials = credentials; this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 45_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 60_000) throw new TypeError("Text request timeout must be between 1 and 60000 milliseconds.");
  }
  private requireOpen() { if (this.closed) throw new ApiError(503, "TEXT_STOPPING", "The studio is restarting. Try again shortly."); }
  private saved(): SavedSettings {
    const value = this.store.metadata<SavedSettings>(metadataKey);
    if (!value) return { version: 1, revision: 0, baseUrl: "", assistant: null };
    if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.baseUrl !== "string" || (value.assistant !== null && (!object(value.assistant) || !["gemini", "openai-compatible"].includes(value.assistant.provider) || !validModelId(value.assistant.modelId)))) throw new ApiError(503, "TEXT_SETTINGS_UNREADABLE", "Saved text settings could not be read.");
    return structuredClone(value);
  }
  settings(): TextSettings {
    const saved = this.saved();
    return { revision: saved.revision, connection: { baseUrl: saved.baseUrl, credential: this.credentials.status(credentialId) }, assistant: saved.assistant };
  }
  private expectRevision(expected: unknown): SavedSettings {
    revision(expected);
    const current = this.saved();
    if (current.revision !== expected) throw changed();
    return current;
  }
  private invalidate() {
    this.cache.clear();
    for (const controller of this.operations.keys()) controller.abort(changed());
  }
  saveConnection(body: unknown): TextSettings {
    this.requireOpen();
    check(object(body) && Object.keys(body).every(key => ["revision", "baseUrl", "apiKey"].includes(key)), "Supply the text connection URL, revision and optional API key.");
    const baseUrl = textBaseUrl(body.baseUrl);
    check(!Object.hasOwn(body, "apiKey") || body.apiKey === null || typeof body.apiKey === "string", "Supply a replacement API key or null to remove it.");
    check(!!baseUrl || !body.apiKey, "Set the API base URL before saving a key.");
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.expectRevision(body.revision);
      const destinationChanged = current.baseUrl !== baseUrl;
      if (typeof body.apiKey === "string") this.credentials.set(credentialId, body.apiKey);
      else if (body.apiKey === null || destinationChanged || !baseUrl) this.credentials.delete(credentialId);
      this.store.setMetadata(metadataKey, { ...current, revision: current.revision + 1, baseUrl, assistant: destinationChanged && current.assistant?.provider === "openai-compatible" ? null : current.assistant });
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    this.invalidate();
    return this.settings();
  }
  async saveAssistant(body: unknown): Promise<TextSettings> {
    this.requireOpen();
    check(object(body) && Object.keys(body).every(key => ["revision", "provider", "modelId"].includes(key)), "Choose a text provider and model, or disable the assistant.");
    this.expectRevision(body.revision);
    let assistant: TextSettings["assistant"] = null;
    let identity: string | undefined;
    if (body.provider !== null || body.modelId !== null) {
      const provider = providerId(body.provider);
      check(validModelId(body.modelId), "Choose a model returned by the selected connection.");
      identity = this.connectionIdentity(this.connection(provider));
      const available = await this.models(provider);
      if (!available.models.some(model => model.id === body.modelId)) throw new ApiError(400, "TEXT_MODEL_UNAVAILABLE", "The selected text model is not available from this connection.");
      assistant = { provider, modelId: body.modelId };
    }
    this.requireOpen();
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.expectRevision(body.revision);
      if (assistant && identity !== this.connectionIdentity(this.connection(assistant.provider))) throw changed();
      this.store.setMetadata(metadataKey, { ...current, revision: current.revision + 1, assistant });
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    this.invalidate();
    return this.settings();
  }
  private connection(provider: TextProviderId): TextConnection {
    if (provider === "gemini") {
      const apiKey = this.credentials.get("gemini");
      if (!apiKey) throw new ApiError(409, "TEXT_KEY_REQUIRED", "Save a Gemini API key in Settings → Integrations first.");
      return { provider, baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey };
    }
    const baseUrl = textBaseUrl(this.saved().baseUrl);
    if (!baseUrl) throw new ApiError(409, "TEXT_CONNECTION_REQUIRED", "Configure an OpenAI-compatible API base URL first.");
    return { provider, baseUrl, apiKey: this.credentials.get(credentialId) };
  }
  private connectionIdentity(connection: TextConnection): string {
    return createHash("sha256").update(JSON.stringify([connection.provider, connection.baseUrl, connection.apiKey ?? null])).digest("hex");
  }
  private operation<T>(work: (signal: AbortSignal) => Promise<T>, external?: AbortSignal, timeoutMs = this.timeoutMs): Promise<T> {
    this.requireOpen();
    const controller = new AbortController();
    const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new ApiError(504, "TEXT_TIMEOUT", "The text provider took too long to respond. Your original prompt is unchanged.")), timeoutMs);
    const flight = Promise.resolve().then(() => { if (signal.aborted) throw cancelled(signal); return work(signal); }).finally(() => { clearTimeout(timer); this.operations.delete(controller); });
    this.operations.set(controller, flight);
    return flight;
  }
  private async discovered(connection: TextConnection, signal: AbortSignal, refresh = false): Promise<TextModels> {
    const identity = this.connectionIdentity(connection), cached = this.cache.get(connection.provider);
    if (!refresh && cached?.identity === identity && Date.now() - cached.at < 60_000) return structuredClone(cached.result);
    if (refresh) this.cache.delete(connection.provider);
    if (this.discovering.has(connection.provider)) throw new ApiError(409, "TEXT_DISCOVERY_BUSY", "Text models are already being checked. Wait for the result.");
    this.discovering.add(connection.provider);
    try {
      const models = await discoverTextModels(connection, signal, this.fetcher);
      if (signal.aborted) throw cancelled(signal);
      if (this.connectionIdentity(this.connection(connection.provider)) !== identity) throw changed();
      const result = { provider: connection.provider, models };
      this.cache.set(connection.provider, { identity, at: Date.now(), result });
      return structuredClone(result);
    } finally { this.discovering.delete(connection.provider); }
  }
  models(provider: unknown, signal?: AbortSignal, refresh = false): Promise<TextModels> {
    const connection = this.connection(providerId(provider));
    return this.operation(inner => this.discovered(connection, inner, refresh), signal, Math.min(this.timeoutMs, 12_000));
  }
  refine(body: unknown, signal?: AbortSignal): Promise<PromptRefinementResult> {
    this.requireOpen();
    check(object(body) && Object.keys(body).every(key => ["settingsRevision", "prompt", "imageModelId", "instruction"].includes(key)), "Supply the image prompt, image model and current text settings revision.");
    const settings = this.expectRevision(body.settingsRevision);
    check(typeof body.prompt === "string" && body.prompt.length <= 16_000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body.prompt), "The prompt must contain at most 16,000 characters.");
    check(body.instruction === undefined || typeof body.instruction === "string" && body.instruction.length <= 2000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body.instruction), "Refinement instructions must contain at most 2,000 characters.");
    check(!!body.prompt.trim() || !!body.instruction?.trim(), "Write a prompt or describe what you want in the refinement instructions.");
    const model = modelRegistry(this.store).find(model => model.id === body.imageModelId);
    check(model, "Choose an image model from this studio's catalog.");
    if (!settings.assistant) throw new ApiError(409, "TEXT_ASSISTANT_REQUIRED", "Choose a prompt assistant in Settings first.");
    if (this.refining) throw new ApiError(409, "TEXT_BUSY", "A prompt refinement is already running. Wait for it to finish or cancel it.");
    const { provider, modelId } = settings.assistant;
    const connection = this.connection(provider), identity = this.connectionIdentity(connection);
    const originalPrompt = body.prompt, instruction = body.instruction;
    const prompt = buildRefinementPrompt(model, originalPrompt, instruction);
    this.refining = true;
    return this.operation(async inner => {
      const available = await this.discovered(connection, inner);
      const textModel = available.models.find(item => item.id === modelId);
      if (!textModel) throw new ApiError(409, "TEXT_MODEL_UNAVAILABLE", "The saved text model is no longer available. Choose another model in Settings.");
      const unchanged = () => { if (inner.aborted) throw cancelled(inner); this.expectRevision(settings.revision); if (this.connectionIdentity(this.connection(provider)) !== identity) throw changed(); };
      unchanged();
      const result = await generateRefinement(connection, textModel, prompt, inner, this.fetcher);
      unchanged();
      const refined = parseRefinementResult(result.text, originalPrompt, instruction);
      if (connection.apiKey && refined.includes(connection.apiKey)) throw new ApiError(502, "TEXT_INVALID_RESPONSE", "The text provider returned an invalid refinement.");
      return { prompt: refined, originalPrompt, provider, modelId, ...(result.usage ? { usage: result.usage } : {}) };
    }, signal).finally(() => { this.refining = false; });
  }
  async close() {
    this.closed = true;
    for (const controller of this.operations.keys()) controller.abort(new ApiError(503, "TEXT_STOPPING", "The studio is restarting. Try again shortly."));
    await Promise.allSettled(this.operations.values());
    this.cache.clear();
  }
}
