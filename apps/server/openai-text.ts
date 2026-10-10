import { randomUUID } from 'node:crypto';
import { ApiError } from '../../packages/contracts/index.ts';
import { abortable, cancelled } from '../../packages/text/providers.ts';
import type { GatewayTextContext, TextMeter, TextService } from './text.ts';

const requestLimit = 1024 * 1024;
const eventLimit = 1024 * 1024;
const responseLimit = 16 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new ApiError(502, 'TEXT_INVALID_RESPONSE', 'The text provider returned an invalid chat response.');
function check(value: unknown, message: string): asserts value { if (!value) throw new ApiError(400, 'INVALID_CHAT_REQUEST', message); }
function fields(value: Record<string, unknown>, allowed: string[], label: string) { check(Object.keys(value).every(key => allowed.includes(key)), `${label} contains unsupported fields.`); }
function boundedText(value: unknown, limit: number): value is string { return typeof value === 'string' && value.length <= limit && !/[\x00\x0b\x0c\x7f]/.test(value); }
function functionName(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value); }

export interface ChatRequest extends Record<string, unknown> { model: string; messages: Record<string, unknown>[]; stream?: boolean }
/** Validate supported OpenAI fields before resolving any provider or admitting GPU work. */
export function parseChatRequest(body: unknown): ChatRequest {
  check(object(body), 'Supply a JSON chat completion request.');
  check(Buffer.byteLength(JSON.stringify(body)) <= requestLimit, 'The chat request exceeds 1 MiB.');
  fields(body, ['model', 'messages', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'n', 'stop', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'seed', 'frequency_penalty', 'presence_penalty', 'reasoning_effort', 'user'], 'The chat request');
  check(typeof body.model === 'string' && body.model.length > 0 && body.model.length <= 300 && !/[\x00-\x20\x7f]/.test(body.model), 'Supply a text model ID from /v1/models.');
  check(Array.isArray(body.messages) && body.messages.length > 0 && body.messages.length <= 256, 'Supply between 1 and 256 messages.');
  for (const message of body.messages) {
    check(object(message), 'Each message must be an object.');
    fields(message, ['role', 'content', 'name', 'tool_call_id', 'tool_calls', 'reasoning_content'], 'A message');
    check(typeof message.role === 'string' && ['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role), 'Use a system, developer, user, assistant or tool message role.');
    if (message.name !== undefined) check(functionName(message.name), 'Message names must contain 1–64 letters, numbers, underscores or hyphens.');
    if (message.content === null || message.content === undefined) check(message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0, 'Only assistant tool calls may omit content.');
    else if (Array.isArray(message.content)) {
      check(message.content.length > 0 && message.content.length <= 256, 'Supply text content parts.');
      for (const part of message.content) {
        check(object(part), 'Each content part must be a text object.'); fields(part, ['type', 'text'], 'A content part');
        check(part.type === 'text' && boundedText(part.text, 262_144), 'This endpoint accepts text messages. Use the image endpoints for image workflows.');
      }
    } else check(boundedText(message.content, 262_144), 'Message content must be text of at most 262,144 characters.');
    if (message.role === 'tool') check(boundedText(message.tool_call_id, 128) && message.tool_call_id.length > 0, 'Tool messages need a tool_call_id.');
    else check(message.tool_call_id === undefined, 'Only tool messages may contain tool_call_id.');
    if (message.reasoning_content !== undefined) check(message.role === 'assistant' && boundedText(message.reasoning_content, 262_144), 'Only assistant messages may include reasoning_content.');
    if (message.tool_calls !== undefined) {
      check(message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0 && message.tool_calls.length <= 128, 'Only assistant messages may contain up to 128 function tool calls.');
      for (const call of message.tool_calls) {
        check(object(call), 'A tool call must be an object.'); fields(call, ['id', 'type', 'function', 'extra_content'], 'A tool call');
        check(boundedText(call.id, 128) && call.id.length > 0 && call.type === 'function' && object(call.function), 'Supply a function tool call with its ID.');
        fields(call.function, ['name', 'arguments'], 'A called function');
        check(functionName(call.function.name) && boundedText(call.function.arguments, 262_144), 'Supply a function name and JSON arguments string.');
        // Gemini returns this signature for multi-turn function calling. Preserve it.
        if (call.extra_content !== undefined) {
          check(object(call.extra_content), 'Invalid function call signature.'); fields(call.extra_content, ['google'], 'A function call signature');
          check(object(call.extra_content.google), 'Invalid function call signature.'); fields(call.extra_content.google, ['thought_signature'], 'A Google function call signature');
          check(boundedText(call.extra_content.google.thought_signature, 65_536), 'Invalid function call signature.');
        }
      }
    }
  }
  if (body.stream !== undefined) check(typeof body.stream === 'boolean', 'stream must be a boolean.');
  if (body.stream_options !== undefined) {
    check(body.stream === true && object(body.stream_options), 'stream_options requires stream: true.'); fields(body.stream_options, ['include_usage'], 'stream_options');
    if (body.stream_options.include_usage !== undefined) check(typeof body.stream_options.include_usage === 'boolean', 'include_usage must be a boolean.');
  }
  check(body.max_tokens === undefined || body.max_completion_tokens === undefined, 'Choose max_tokens or max_completion_tokens, not both.');
  for (const field of ['max_tokens', 'max_completion_tokens']) if (body[field] !== undefined) check(Number.isSafeInteger(body[field]) && Number(body[field]) >= 1 && Number(body[field]) <= 131_072, `${field} must be an integer between 1 and 131072.`);
  for (const [field, minimum, maximum] of [['temperature', 0, 2], ['top_p', 0, 1], ['frequency_penalty', -2, 2], ['presence_penalty', -2, 2]] as const) {
    if (body[field] !== undefined) check(typeof body[field] === 'number' && Number.isFinite(body[field]) && body[field] >= minimum && body[field] <= maximum, `${field} must be between ${minimum} and ${maximum}.`);
  }
  if (body.n !== undefined) check(body.n === 1, 'Studio produces one chat completion per request; use n: 1.');
  if (body.seed !== undefined) check(Number.isSafeInteger(body.seed) && Number(body.seed) >= -(2 ** 31) && Number(body.seed) <= 2 ** 31 - 1, 'seed must be a signed 32-bit integer.');
  if (body.stop !== undefined && body.stop !== null) check(boundedText(body.stop, 1024) && !!body.stop.length || Array.isArray(body.stop) && body.stop.length > 0 && body.stop.length <= 4 && body.stop.every(stop => boundedText(stop, 1024) && !!stop.length), 'stop must be a string or up to four nonempty strings.');
  if (body.user !== undefined) check(boundedText(body.user, 256), 'user must be a string of at most 256 characters.');
  if (body.reasoning_effort !== undefined) check(typeof body.reasoning_effort === 'string' && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(body.reasoning_effort), 'Choose a supported reasoning_effort.');
  if (body.parallel_tool_calls !== undefined) check(typeof body.parallel_tool_calls === 'boolean', 'parallel_tool_calls must be a boolean.');
  const toolNames = new Set<string>();
  if (body.tools !== undefined) {
    check(Array.isArray(body.tools) && body.tools.length <= 128, 'Supply up to 128 function tools.');
    for (const tool of body.tools) {
      check(object(tool), 'A tool must be an object.'); fields(tool, ['type', 'function'], 'A tool');
      check(tool.type === 'function' && object(tool.function), 'Only function tools are supported.');
      fields(tool.function, ['name', 'description', 'parameters', 'strict'], 'A function tool');
      check(functionName(tool.function.name) && !toolNames.has(tool.function.name), 'Function names must be valid and unique.'); toolNames.add(tool.function.name);
      if (tool.function.description !== undefined) check(boundedText(tool.function.description, 16_384), 'A tool description is too long.');
      if (tool.function.parameters !== undefined) check(object(tool.function.parameters), 'Function parameters must be a JSON schema object.');
      if (tool.function.strict !== undefined && tool.function.strict !== null) check(typeof tool.function.strict === 'boolean', 'Function strict must be a boolean.');
    }
  }
  if (body.tool_choice !== undefined) {
    if (typeof body.tool_choice === 'string') check(['none', 'auto', 'required'].includes(body.tool_choice), 'Choose none, auto, required or a named function tool.');
    else {
      check(object(body.tool_choice), 'Choose a function tool.'); fields(body.tool_choice, ['type', 'function'], 'tool_choice');
      check(body.tool_choice.type === 'function' && object(body.tool_choice.function), 'Choose a function tool.'); fields(body.tool_choice.function, ['name'], 'tool_choice.function');
      check(functionName(body.tool_choice.function.name) && toolNames.has(body.tool_choice.function.name), 'The chosen function must be included in tools.');
    }
    if (body.tool_choice !== 'none') check(toolNames.size > 0, 'tool_choice requires function tools.');
  }
  if (body.response_format !== undefined) {
    check(object(body.response_format), 'response_format must be an object.'); fields(body.response_format, ['type', 'json_schema'], 'response_format');
    check(typeof body.response_format.type === 'string' && ['text', 'json_object', 'json_schema'].includes(body.response_format.type), 'Choose text, json_object or json_schema response format.');
    if (body.response_format.type === 'json_schema') {
      const schema = body.response_format.json_schema; check(object(schema), 'Supply a named JSON schema.'); fields(schema, ['name', 'description', 'schema', 'strict'], 'response_format.json_schema');
      check(functionName(schema.name) && object(schema.schema), 'Supply a valid JSON schema name and schema object.');
      if (schema.description !== undefined) check(boundedText(schema.description, 16_384), 'The schema description is too long.');
      if (schema.strict !== undefined && schema.strict !== null) check(typeof schema.strict === 'boolean', 'Schema strict must be a boolean.');
    } else check(body.response_format.json_schema === undefined, 'json_schema requires the json_schema response format.');
  }
  return structuredClone(body) as ChatRequest;
}

async function upstream(request: ChatRequest, context: GatewayTextContext): Promise<Response> {
  const { connection, model, signal, fetcher } = context;
  const maxTokens = Number(request.max_completion_tokens ?? request.max_tokens ?? Math.min(4096, model.outputTokenLimit ?? 4096));
  if (model.outputTokenLimit && maxTokens > model.outputTokenLimit) throw new ApiError(400, 'TEXT_OUTPUT_TOO_LONG', `This text model accepts at most ${model.outputTokenLimit} output tokens.`);
  if (model.inputTokenLimit && Buffer.byteLength(JSON.stringify([request.messages, request.tools ?? []])) > model.inputTokenLimit) throw new ApiError(400, 'TEXT_INPUT_TOO_LONG', 'The messages and tools exceed this model’s conservative input limit. Shorten the conversation or choose a model with a larger context.');
  const baseUrl = connection.provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai' : connection.baseUrl;
  const body = { ...request, model: model.id, stream: request.stream === true, ...(request.max_tokens === undefined && request.max_completion_tokens === undefined ? { max_tokens: maxTokens } : {}) };
  let response: Response;
  try {
    response = await abortable(fetcher(`${baseUrl}/chat/completions`, { method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', accept: request.stream ? 'text/event-stream' : 'application/json', ...(connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {}) }, body: JSON.stringify(body) }), signal);
  } catch (error) {
    if (signal.aborted) throw cancelled(signal);
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'TEXT_UNAVAILABLE', 'The text provider could not be reached.');
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    if ([401, 403].includes(response.status)) throw new ApiError(502, 'TEXT_ACCESS_DENIED', 'The text provider denied access. Ask an administrator to check the saved connection.');
    if (response.status === 429) throw new ApiError(429, 'TEXT_RATE_LIMITED', 'The text provider is rate limiting requests. Try again shortly.');
    if ([400, 404, 405, 415, 422].includes(response.status)) throw new ApiError(400, 'TEXT_REQUEST_UNSUPPORTED', 'The selected provider or model does not support these chat parameters.');
    throw new ApiError(502, 'TEXT_UNAVAILABLE', 'The text provider could not complete this request.');
  }
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!response.body || Number(response.headers.get('content-length')) > responseLimit || (request.stream ? contentType !== 'text/event-stream' : contentType !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(contentType ?? ''))) {
    void response.body?.cancel().catch(() => {}); throw invalid();
  }
  return response;
}

function completion(value: unknown, model: string, streamed: boolean, fallbackId: string, apiKey?: string): Record<string, unknown> {
  if (!object(value) || value.error || !Array.isArray(value.choices) || value.choices.length > 1 || (!streamed && !value.choices.length)) throw invalid();
  // Never relay arbitrary upstream diagnostics or credentials, even with HTTP 200.
  if (apiKey && JSON.stringify(value).includes(apiKey)) throw invalid();
  for (const choice of value.choices) {
    if (!object(choice) || choice.index !== 0 || !object(choice[streamed ? 'delta' : 'message'])) throw invalid();
    if (choice.finish_reason !== null && choice.finish_reason !== undefined && (typeof choice.finish_reason !== 'string' || !['stop', 'length', 'tool_calls', 'content_filter', 'function_call'].includes(choice.finish_reason))) throw invalid();
    const message = choice[streamed ? 'delta' : 'message'] as Record<string, unknown>;
    if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') throw invalid();
    if (!streamed && message.role !== 'assistant') throw invalid();
    if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw invalid();
  }
  return { id: typeof value.id === 'string' && value.id.length <= 256 ? value.id : fallbackId, object: streamed ? 'chat.completion.chunk' : 'chat.completion', created: Number.isSafeInteger(value.created) ? value.created : Math.floor(Date.now() / 1000), model, choices: value.choices, ...(object(value.usage) ? { usage: value.usage } : {}), ...(typeof value.system_fingerprint === 'string' ? { system_fingerprint: value.system_fingerprint } : {}) };
}
async function readCompletion(response: Response, request: ChatRequest, context: GatewayTextContext): Promise<Record<string, unknown>> {
  const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let bytes = 0, finished = false;
  try {
    for (;;) { const item = await abortable(reader.read(), context.signal); if (item.done) { finished = true; break; } bytes += item.value.byteLength; if (bytes > responseLimit) throw invalid(); chunks.push(item.value); }
    return completion(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), request.model, false, `chatcmpl-${randomUUID()}`, context.connection.apiKey);
  } catch (error) { if (context.signal.aborted) throw cancelled(context.signal); if (error instanceof ApiError) throw error; throw invalid(); }
  finally { if (!finished) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function streamCompletion(response: Response, request: ChatRequest, context: GatewayTextContext, writer: WritableStreamDefaultWriter<Uint8Array>) {
  const reader = response.body!.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }), encoder = new TextEncoder();
  let buffer = '', bytes = 0, done = false, hadFinish = false; const fallbackId = `chatcmpl-${randomUUID()}`;
  const emit = (data: string) => abortable(writer.write(encoder.encode(`data: ${data}\n\n`)), context.signal);
  const event = async (block: string) => {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    if (data === '[DONE]') { if (!hadFinish) throw invalid(); done = true; await emit('[DONE]'); return; }
    const value = completion(JSON.parse(data), request.model, true, fallbackId, context.connection.apiKey);
    if ((value.choices as Record<string, unknown>[]).some(choice => typeof choice.finish_reason === 'string')) hadFinish = true;
    await emit(JSON.stringify(value));
  };
  try {
    while (!done) {
      const item = await abortable(reader.read(), context.signal);
      if (item.done) { buffer += decoder.decode(); break; }
      bytes += item.value.byteLength; if (bytes > responseLimit) throw invalid();
      buffer += decoder.decode(item.value, { stream: true });
      // Normalize only complete CRLF pairs, retaining a trailing CR across chunks.
      buffer = buffer.replace(/\r\n/g, '\n');
      for (let index; !done && (index = buffer.indexOf('\n\n')) >= 0;) {
        if (index > eventLimit) throw invalid(); const block = buffer.slice(0, index); buffer = buffer.slice(index + 2); await event(block);
      }
      if (buffer.length > eventLimit) throw invalid();
    }
    if (!done && buffer.trim()) await event(buffer.replace(/\r\n/g, '\n'));
    if (!done) throw new ApiError(502, 'TEXT_STREAM_INTERRUPTED', 'The text provider ended the response before completion.');
  } catch (error) { if (context.signal.aborted) throw cancelled(context.signal); if (error instanceof ApiError) throw error; throw invalid(); }
  finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
const headers = { 'cache-control': 'private, no-store, no-transform', 'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' };

/** Holds the local GPU admission and work-time meter until the downstream stream ends. */
export async function openaiChat(service: TextService, body: unknown, external?: AbortSignal, meter?: TextMeter): Promise<Response> {
  const request = parseChatRequest(body);
  const controller = new AbortController(); const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
  if (!request.stream) return service.runGateway(request.model, async context => Response.json(await readCompletion(await upstream(request, context), request, context), { headers }), signal, meter);
  const stream = new TransformStream<Uint8Array, Uint8Array>(); const writer = stream.writable.getWriter();
  // Cancelling the HTTP response must cancel provider inference, including while waiting for its next token.
  void writer.closed.catch(() => controller.abort());
  let published = false;
  return new Promise<Response>((resolve, reject) => {
    const fail = async (error: unknown) => {
      if (!published) { void writer.abort(error).catch(() => {}); reject(error); return; }
      if (!signal.aborted) {
        const failure = error instanceof ApiError ? error : invalid();
        const errorSignal = AbortSignal.any([signal, AbortSignal.timeout(1000)]);
        try { await abortable(writer.write(new TextEncoder().encode(`data: ${JSON.stringify({ error: { message: failure.message, type: 'server_error', param: null, code: failure.code } })}\n\n`)), errorSignal); await abortable(writer.close(), errorSignal); return; } catch { /* Disconnected clients need no error frame. */ }
      }
      void writer.abort(error).catch(() => {});
    };
    try {
      void service.runGateway(request.model, async context => {
        const response = await upstream(request, context);
        published = true; resolve(new Response(stream.readable, { headers: { ...headers, 'content-type': 'text/event-stream; charset=utf-8' } }));
        await streamCompletion(response, request, context, writer);
        await abortable(writer.close(), context.signal);
      }, signal, meter).catch(fail);
    } catch (error) { void fail(error); }
  });
}
