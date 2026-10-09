import { ApiError } from "../contracts/index.ts";
import type { TextModel, TextProviderId, PromptRefinementResult } from "../contracts/text.ts";

export interface TextConnection { provider: TextProviderId; baseUrl: string; apiKey?: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const invalid = () => new ApiError(502, "TEXT_INVALID_RESPONSE", "The text provider returned an invalid response. Your original prompt is unchanged.");
export function cancelled(signal: AbortSignal): ApiError {
  return signal.reason instanceof ApiError ? signal.reason : new ApiError(499, "TEXT_CANCELLED", "The text request was cancelled.");
}
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw cancelled(signal);
  let listener: () => void = () => {};
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      listener = () => reject(cancelled(signal));
      signal.addEventListener("abort", listener, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", listener); }
}

async function jsonRequest(connection: TextConnection, url: string, signal: AbortSignal, fetcher: typeof fetch, body?: unknown): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (connection.apiKey) headers[connection.provider === "gemini" ? "x-goog-api-key" : "Authorization"] = connection.provider === "gemini" ? connection.apiKey : `Bearer ${connection.apiKey}`;
  let response: Response;
  try {
    if (signal.aborted) throw cancelled(signal);
    response = await abortable(fetcher(url, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal }), signal);
  } catch (error) {
    if (signal.aborted) throw cancelled(signal);
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "TEXT_UNAVAILABLE", "Could not reach the text provider. Check its address and try again.");
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) throw new ApiError(400, "TEXT_ACCESS_DENIED", "The text provider denied access. Check the saved key and model permissions.");
    if (response.status === 429) throw new ApiError(429, "TEXT_RATE_LIMITED", "The text provider is rate limiting requests. Wait before trying again.");
    if ([400, 404, 405, 415, 422].includes(response.status)) throw new ApiError(400, "TEXT_REQUEST_UNSUPPORTED", "The endpoint or model does not support this text request. Choose a chat model with JSON output support and check the API base URL.");
    throw new ApiError(502, "TEXT_UNAVAILABLE", "The text provider could not complete the request. Your original prompt is unchanged.");
  }
  const limit = 512 * 1024;
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (!contentType || !(contentType === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(contentType)) || Number(response.headers.get("content-length")) > limit || !response.body) {
    void response.body?.cancel().catch(() => {}); throw invalid();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0, done = false;
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) { done = true; break; }
      bytes += next.value.byteLength;
      if (bytes > limit) throw invalid();
      chunks.push(next.value);
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!object(value)) throw invalid();
    return value;
  } catch (error) {
    if (signal.aborted) throw cancelled(signal);
    if (error instanceof ApiError) throw error;
    throw invalid();
  } finally {
    if (!done) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const positiveInteger = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2 ** 31 ? value : undefined;
const modelName = (value: unknown, fallback: string): string => typeof value === "string" && value.trim() && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) ? value : fallback;
export function validModelId(value: unknown): value is string { return typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value); }
function containsCredential(value: string, connection: TextConnection): boolean { return !!connection.apiKey && value.includes(connection.apiKey); }

/** Discovery is bounded and never follows provider-supplied URLs. */
export async function discoverTextModels(connection: TextConnection, signal: AbortSignal, fetcher: typeof fetch): Promise<TextModel[]> {
  const models = new Map<string, TextModel>();
  let pageToken: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 5; page++) {
    const url = new URL(`${connection.baseUrl}/models`);
    if (connection.provider === "gemini") { url.searchParams.set("pageSize", "100"); if (pageToken) url.searchParams.set("pageToken", pageToken); }
    const response = await jsonRequest(connection, url.toString(), signal, fetcher);
    const rows = connection.provider === "gemini" ? response.models : response.data;
    if (!Array.isArray(rows) || rows.length > 500) throw invalid();
    for (const row of rows) {
      if (!object(row)) throw invalid();
      let id: string;
      if (connection.provider === "gemini") {
        if (typeof row.name !== "string" || !/^models\/[a-zA-Z0-9._-]{1,200}$/.test(row.name)) throw invalid();
        id = row.name.slice(7);
        if (!Array.isArray(row.supportedGenerationMethods) || !row.supportedGenerationMethods.includes("generateContent")) continue;
        if (!id.startsWith("gemini-") || /(?:image|audio|tts|embed|robotics|computer-use|deep-research|live)/i.test(id)) continue;
      } else {
        if (!validModelId(row.id)) throw invalid();
        id = row.id;
        if (/(?:^|[-_/])(?:embedding|embeddings|embed|rerank|reranker|whisper|tts)(?:[-_/]|$)/i.test(id)) continue;
      }
      const name = modelName(row.displayName ?? row.name, id);
      if (containsCredential(id, connection) || containsCredential(name, connection)) throw invalid();
      const inputTokenLimit = positiveInteger(row.inputTokenLimit), outputTokenLimit = positiveInteger(row.outputTokenLimit);
      models.set(id, { id, name, ...(inputTokenLimit ? { inputTokenLimit } : {}), ...(outputTokenLimit ? { outputTokenLimit } : {}) });
      if (models.size > 500) throw invalid();
    }
    if (connection.provider !== "gemini") {
      if (response.has_more === true || response.next_page !== undefined || response.nextPageToken !== undefined) throw new ApiError(502, "TEXT_CATALOG_TOO_LARGE", "This endpoint returned a paginated model catalog that is not supported.");
      return [...models.values()];
    }
    if (!response.nextPageToken) return [...models.values()];
    if (typeof response.nextPageToken !== "string" || response.nextPageToken.length > 1024 || /[\x00-\x20\x7f]/.test(response.nextPageToken) || seen.has(response.nextPageToken)) throw invalid();
    pageToken = response.nextPageToken; seen.add(pageToken);
  }
  throw new ApiError(502, "TEXT_CATALOG_TOO_LARGE", "The provider returned too many model pages. Use a smaller text model catalog.");
}

function usage(value: unknown, input: string, output: string): PromptRefinementResult["usage"] {
  if (!object(value)) return undefined;
  const valid = (item: unknown): item is number => typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
  const inputTokens = valid(value[input]) ? value[input] as number : undefined;
  const outputTokens = valid(value[output]) ? value[output] as number : undefined;
  return inputTokens !== undefined || outputTokens !== undefined ? { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) } : undefined;
}

export async function generateRefinement(connection: TextConnection, model: TextModel, prompt: { system: string; user: string }, signal: AbortSignal, fetcher: typeof fetch): Promise<{ text: string; usage?: PromptRefinementResult["usage"] }> {
  const maxTokens = Math.min(4096, model.outputTokenLimit ?? 4096);
  if (model.inputTokenLimit && Buffer.byteLength(prompt.system + prompt.user, "utf8") > model.inputTokenLimit) throw new ApiError(400, "TEXT_INPUT_TOO_LONG", "This prompt exceeds the selected model's conservative input limit. Shorten it or choose a model with a larger context.");
  const schema = { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"], additionalProperties: false };
  const gemini = connection.provider === "gemini";
  const body = gemini ? {
    systemInstruction: { parts: [{ text: prompt.system }] }, contents: [{ role: "user", parts: [{ text: prompt.user }] }],
    // Native generateContent REST response format, documented by Google.
    generationConfig: { candidateCount: 1, maxOutputTokens: maxTokens, responseFormat: { text: { mimeType: "APPLICATION_JSON", schema } } },
  } : {
    model: model.id, messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }],
    stream: false, max_tokens: maxTokens, response_format: { type: "json_object" },
  };
  const url = gemini ? `${connection.baseUrl}/models/${encodeURIComponent(model.id)}:generateContent` : `${connection.baseUrl}/chat/completions`;
  const response = await jsonRequest(connection, url, signal, fetcher, body);
  let text: string, stats: PromptRefinementResult["usage"];
  if (gemini) {
    if (object(response.promptFeedback) && response.promptFeedback.blockReason) throw new ApiError(422, "TEXT_RESPONSE_BLOCKED", "The provider could not return a refinement for this prompt.");
    if (!Array.isArray(response.candidates) || response.candidates.length !== 1 || !object(response.candidates[0])) throw invalid();
    const candidate = response.candidates[0];
    if (candidate.finishReason === "MAX_TOKENS") throw new ApiError(502, "TEXT_RESPONSE_TRUNCATED", "The refinement was cut short. Shorten the prompt or choose another model.");
    if (candidate.finishReason !== "STOP") throw new ApiError(422, "TEXT_RESPONSE_BLOCKED", "The provider did not complete the refinement. Your original prompt is unchanged.");
    if (!object(candidate.content) || !Array.isArray(candidate.content.parts) || !candidate.content.parts.length) throw invalid();
    const parts: string[] = [];
    for (const part of candidate.content.parts) {
      if (!object(part)) throw invalid();
      if (part.thought === true) continue;
      if (typeof part.text !== "string" || Object.keys(part).some(key => !["text", "thought", "thoughtSignature"].includes(key))) throw invalid();
      parts.push(part.text);
    }
    text = parts.join(""); stats = usage(response.usageMetadata, "promptTokenCount", "candidatesTokenCount");
  } else {
    if (!Array.isArray(response.choices) || response.choices.length !== 1 || !object(response.choices[0])) throw invalid();
    const choice = response.choices[0];
    if (choice.finish_reason === "length") throw new ApiError(502, "TEXT_RESPONSE_TRUNCATED", "The refinement was cut short. Shorten the prompt or choose another model.");
    if (choice.finish_reason !== "stop" || !object(choice.message) || choice.message.refusal || choice.message.tool_calls || choice.message.function_call) throw new ApiError(422, "TEXT_RESPONSE_BLOCKED", "The provider did not complete a text refinement. Your original prompt is unchanged.");
    if (typeof choice.message.content !== "string") throw invalid();
    text = choice.message.content; stats = usage(response.usage, "prompt_tokens", "completion_tokens");
  }
  if (!text.length || text.length > 96_000 || containsCredential(text, connection)) throw invalid();
  return { text, ...(stats ? { usage: stats } : {}) };
}
