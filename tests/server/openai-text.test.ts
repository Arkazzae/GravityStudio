import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../apps/server/store.ts';
import { CredentialVault } from '../../apps/server/credentials.ts';
import { TextService } from '../../apps/server/text.ts';
import { openaiChat, parseChatRequest } from '../../apps/server/openai-text.ts';
import type { LocalTextRuntime } from '../../apps/server/local-text.ts';

const secret = 'fixture-gateway-secret-1234';
const model = 'text/openai-compatible/test-chat';
const input = (more: Record<string, unknown> = {}) => ({ model, messages: [{ role: 'user', content: 'Hello' }], ...more });
const complete = (content = 'Hello back') => ({ id: 'chatcmpl-fixture', object: 'chat.completion', created: 7, model: 'upstream-name', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id: 'chatcmpl-fixture', created: 7, choices: [{ index: 0, delta, finish_reason: finish }] });
const sse = (...events: unknown[]) => new Response(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: TestContext, fetcher: typeof fetch = async (_url, init) => init?.method === 'POST' ? Response.json(complete()) : Response.json({ data: [{ id: 'test-chat' }] }), options: { local?: Pick<LocalTextRuntime, 'models' | 'run'>; gatewayTimeoutMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'gravity-gateway-'));
  const store = new Store(directory), credentials = new CredentialVault(store, { key: randomBytes(32).toString('base64') });
  const text = new TextService(store, credentials, { fetch: fetcher, ...options });
  text.saveConnection({ revision: 0, baseUrl: 'http://127.0.0.1:8080/v1', apiKey: secret });
  t.after(async () => { await text.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, credentials, text };
}

test('chat catalog namespaces provider models and follows the chosen assistant without exposing credentials', async t => {
  const f = await fixture(t);
  await f.text.saveAssistant({ revision: 1, provider: 'openai-compatible', modelId: 'test-chat' });
  const found = await f.text.gatewayModels();
  assert.deepEqual(found.map(item => item.id), ['studio-assistant', model]);
  assert.equal(found.every(item => item.object === 'model' && item.type === 'text'), true);
  assert.equal(JSON.stringify(found).includes(secret), false);
  assert.equal(f.text.gatewayLocal('studio-assistant'), false);
  assert.throws(() => f.text.gatewayLocal('arbitrary/model'), { code: 'TEXT_MODEL_UNAVAILABLE' });
  const response = await openaiChat(f.text, input({ model: 'studio-assistant' }));
  const body = await response.json(); assert.equal(body.model, 'studio-assistant'); assert.equal(body.choices[0].message.content, 'Hello back');
  assert.equal(f.store.jobs().length, 0, 'text completions do not create image jobs');
});

test('catalog keeps ready local models when an external provider is offline', async t => {
  const local: Pick<LocalTextRuntime, 'models' | 'run'> = { models: async () => ({ provider: 'local', models: [{ id: 'mimo', name: 'MiMo' }] }), run: async () => { throw new Error('not used'); } };
  const f = await fixture(t, async () => { throw new Error(`offline ${secret}`); }, { local });
  assert.deepEqual((await f.text.gatewayModels()).map(item => item.id), ['text/local/mimo']);
});

test('compatible chat preserves tools, assistant calls, JSON schemas and usage; only saved credentials authenticate upstream', async t => {
  let request: Record<string, unknown> | undefined;
  const f = await fixture(t, async (url, init) => {
    assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`);
    if (init?.method !== 'POST') return Response.json({ data: [{ id: 'test-chat' }] });
    assert.equal(String(url), 'http://127.0.0.1:8080/v1/chat/completions'); request = JSON.parse(String(init.body)); return Response.json(complete());
  });
  const tools = [{ type: 'function', function: { name: 'weather', description: 'Find weather', parameters: { type: 'object', properties: {} }, strict: true } }];
  const messages = [{ role: 'developer', content: 'Use tools.' }, { role: 'assistant', content: null, reasoning_content: 'Need weather', tool_calls: [{ id: 'call-one', type: 'function', function: { name: 'weather', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call-one', content: [{ type: 'text', text: 'Sunny' }] }];
  const response_format = { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: { type: 'object' } } };
  const response = await openaiChat(f.text, input({ messages, tools, tool_choice: { type: 'function', function: { name: 'weather' } }, parallel_tool_calls: true, response_format, temperature: 0.3, top_p: 0.9, max_completion_tokens: 1000, reasoning_effort: 'low' }));
  assert.deepEqual(request!.tools, tools); assert.deepEqual(request!.messages, messages); assert.deepEqual(request!.response_format, response_format);
  assert.equal(request!.model, 'test-chat'); assert.equal(request!.max_completion_tokens, 1000); assert.equal(request!.max_tokens, undefined);
  const result = await response.json(); assert.deepEqual(result.usage, complete().usage); assert.equal(result.model, model);
  assert.match(response.headers.get('cache-control')!, /no-store/); assert.equal(response.headers.has('authorization'), false);
});

test('Gemini uses its fixed OpenAI endpoint and preserves function call thought signatures', async t => {
  let posted = false;
  const f = await fixture(t, async (url, init) => {
    if (init?.method !== 'POST') return Response.json({ models: [{ name: 'models/gemini-test', supportedGenerationMethods: ['generateContent'] }] });
    assert.equal(String(url), 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${secret}`);
    const body = JSON.parse(String(init.body)); assert.equal(body.model, 'gemini-test');
    assert.equal(body.messages[0].tool_calls[0].extra_content.google.thought_signature, 'opaque-signature'); posted = true;
    return sse(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-two', type: 'function', function: { name: 'weather', arguments: '{}' } }] }, 'tool_calls'), '[DONE]');
  });
  f.credentials.set('gemini', secret);
  const response = await openaiChat(f.text, input({ model: 'text/gemini/gemini-test', stream: true, messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call-one', type: 'function', function: { name: 'weather', arguments: '{}' }, extra_content: { google: { thought_signature: 'opaque-signature' } } }] }, { role: 'tool', tool_call_id: 'call-one', content: 'Sunny' }] }));
  const value = await response.text(); assert.equal(posted, true); assert.match(value, /tool_calls/); assert.match(value, /text\/gemini\/gemini-test/); assert.match(value, /data: \[DONE\]/);
});

test('chat rejects unsupported or invalid input before model discovery or admission', async t => {
  let requests = 0, begins = 0;
  const f = await fixture(t, async () => { requests++; throw new Error('Must not fetch'); });
  const invalidBodies = [input({ url: 'http://other' }), input({ apiKey: 'injected' }), input({ messages: [] }), input({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://metadata/' } }] }] }), input({ messages: [{ role: 'tool', content: 'result' }] }), input({ messages: [{ role: 'user', content: null }] }), input({ n: 2 }), input({ temperature: 5 }), input({ messages: [{ role: ['user'], content: 'Hello' }] }), input({ reasoning_effort: ['low'] }), input({ response_format: { type: ['json_object'] } }), input({ max_tokens: 5, max_completion_tokens: 7 }), input({ max_tokens: 0 }), input({ stream_options: { include_usage: true } }), input({ tool_choice: 'required' }), input({ tools: [{ type: 'web_search' }] }), input({ tools: [{ type: 'function', function: { name: 'test' } }], tool_choice: { type: 'function', function: { name: 'other' } } }), input({ response_format: { type: 'json_schema', json_schema: { name: 'missing' } } })];
  for (const body of invalidBodies) await assert.rejects(openaiChat(f.text, body, undefined, { begin: () => begins++, end: () => {} }), { code: 'INVALID_CHAT_REQUEST' });
  assert.equal(requests, 0); assert.equal(begins, 0);
  await assert.rejects(openaiChat(f.text, input({ model: 'text/local/' })), { code: 'TEXT_MODEL_UNAVAILABLE' });
  assert.throws(() => parseChatRequest(input({ messages: Array.from({ length: 257 }, () => ({ role: 'user', content: 'x' })) })), { code: 'INVALID_CHAT_REQUEST' });
});

test('provider errors are translated without leaking bodies, keys, URLs or upstream headers', async t => {
  for (const [status, code] of [[400, 'TEXT_REQUEST_UNSUPPORTED'], [401, 'TEXT_ACCESS_DENIED'], [403, 'TEXT_ACCESS_DENIED'], [429, 'TEXT_RATE_LIMITED'], [500, 'TEXT_UNAVAILABLE']] as const) {
    const f = await fixture(t, async (_url, init) => init?.method === 'POST' ? new Response(`error ${secret} private-host`, { status, headers: { authorization: secret } }) : Response.json({ data: [{ id: 'test-chat' }] }));
    await assert.rejects(openaiChat(f.text, input()), error => error instanceof Error && 'code' in error && error.code === code && !error.message.includes(secret) && !error.message.includes('private-host'));
  }
  const f = await fixture(t, async (_url, init) => init?.method === 'POST' ? Response.json(complete(secret)) : Response.json({ data: [{ id: 'test-chat' }] }));
  await assert.rejects(openaiChat(f.text, input()), { code: 'TEXT_INVALID_RESPONSE' });
});

test('SSE handles split UTF-8 and CRLF frames, usage-only chunks and streamed tool arguments', async t => {
  const wire = [chunk({ role: 'assistant', content: 'Cześć ' }), chunk({ tool_calls: [{ index: 0, id: 'call-one', type: 'function', function: { name: 'weather', arguments: '{' } }] }), chunk({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }, 'tool_calls'), { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }, '[DONE]'].map(value => `: comment\r\ndata: ${typeof value === 'string' ? value : JSON.stringify(value)}\r\n\r\n`).join('');
  const f = await fixture(t, async (_url, init) => {
    if (init?.method !== 'POST') return Response.json({ data: [{ id: 'test-chat' }] });
    const bytes = new TextEncoder().encode(wire); let index = 0;
    return new Response(new ReadableStream({ pull(controller) { if (index === bytes.length) controller.close(); else controller.enqueue(bytes.slice(index, ++index)); } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const response = await openaiChat(f.text, input({ stream: true, stream_options: { include_usage: true } }));
  const wireResult = await response.text();
  assert.match(wireResult, /Cześć/); assert.match(wireResult, /tool_calls/); assert.match(wireResult, /"total_tokens":14/); assert.match(wireResult, /data: \[DONE\]\n\n$/); assert.equal(wireResult.includes('comment'), false);
});

test('local chat retains GPU admission and work-time accounting until the stream drains', async t => {
  let active = false, begins = 0, ends = 0, releases = 0;
  const local: Pick<LocalTextRuntime, 'models' | 'run'> = {
    models: async () => ({ provider: 'local', models: [{ id: 'mimo', name: 'MiMo' }] }),
    run: async (_id, _signal, work, admitted) => {
      active = true; admitted?.();
      try { return await work({ provider: 'openai-compatible', baseUrl: 'http://managed.local/v1', apiKey: secret }, { id: 'mimo', name: 'MiMo', inputTokenLimit: 4096, outputTokenLimit: 2048 }); }
      finally { active = false; releases++; }
    },
  };
  const f = await fixture(t, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, 'mimo'); assert.equal(body.max_tokens, 2048);
    return sse(chunk({ role: 'assistant', content: 'Hello' }), chunk({}, 'stop'), '[DONE]');
  }, { local });
  const response = await openaiChat(f.text, input({ model: 'text/local/mimo', stream: true }), undefined, { begin: () => begins++, end: () => ends++ });
  assert.equal(active, true); assert.equal(begins, 1); assert.equal(ends, 0);
  assert.match(await response.text(), /\[DONE\]/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active, false); assert.equal(releases, 1); assert.equal(ends, 1);
});

test('disconnect cancels inference even while awaiting a provider token and releases local metering', async t => {
  let providerSignal: AbortSignal | undefined, cancelledBody = false; const released = deferred(); let ends = 0;
  const local: Pick<LocalTextRuntime, 'models' | 'run'> = {
    models: async () => ({ provider: 'local', models: [{ id: 'mimo', name: 'MiMo' }] }),
    run: async (_id, _signal, work, admitted) => { admitted?.(); try { return await work({ provider: 'openai-compatible', baseUrl: 'http://local/v1' }, { id: 'mimo', name: 'MiMo' }); } finally { released.resolve(); } },
  };
  const f = await fixture(t, async (_url, init) => {
    providerSignal = init?.signal as AbortSignal;
    return new Response(new ReadableStream({ cancel() { cancelledBody = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  }, { local });
  const response = await openaiChat(f.text, input({ model: 'text/local/mimo', stream: true }), undefined, { begin: () => {}, end: () => ends++ });
  await response.body!.cancel(); await released.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(providerSignal!.aborted, true); assert.equal(cancelledBody, true); assert.equal(ends, 1);
});

test('local output limits and admission failures do not invoke inference or bill work time', async t => {
  let posts = 0, ends = 0;
  const local: Pick<LocalTextRuntime, 'models' | 'run'> = {
    models: async () => ({ provider: 'local', models: [{ id: 'mimo', name: 'MiMo' }] }),
    run: async (_id, _signal, work, admitted) => { admitted?.(); return work({ provider: 'openai-compatible', baseUrl: 'http://local/v1' }, { id: 'mimo', name: 'MiMo', inputTokenLimit: 500, outputTokenLimit: 2048 }); },
  };
  const f = await fixture(t, async () => { posts++; return Response.json(complete()); }, { local });
  await assert.rejects(openaiChat(f.text, input({ model: 'text/local/mimo', max_tokens: 2049 })), { code: 'TEXT_OUTPUT_TOO_LONG' });
  await assert.rejects(openaiChat(f.text, input({ model: 'text/local/mimo', messages: [{ role: 'user', content: 'x'.repeat(600) }] })), { code: 'TEXT_INPUT_TOO_LONG' });
  await assert.rejects(openaiChat(f.text, input({ model: 'text/local/mimo' }), undefined, { begin: () => { throw new Error('Allowance exhausted'); }, end: () => ends++ }), /Allowance exhausted/);
  assert.equal(posts, 0); assert.equal(ends, 0);
});

test('gateway enforces concurrency and cancellation without retrying accepted completions', async t => {
  let posts = 0; const started = deferred(); const f = await fixture(t, async (_url, init) => {
    if (init?.method !== 'POST') return Response.json({ data: [{ id: 'test-chat' }] });
    posts++; if (posts === 4) started.resolve(); return new Promise<Response>(() => {});
  });
  await f.text.gatewayModels(); const controllers = Array.from({ length: 4 }, () => new AbortController());
  const requests = controllers.map(controller => openaiChat(f.text, input(), controller.signal));
  const rejected = Promise.all(requests.map(request => assert.rejects(request, { code: 'TEXT_CANCELLED' })));
  await started.promise; await assert.rejects(openaiChat(f.text, input()), { code: 'TEXT_BUSY' });
  controllers.forEach(controller => controller.abort()); await rejected; assert.equal(posts, 4);
});

test('settings changes, service shutdown and timeout cancel gateway requests', async t => {
  for (const mode of ['settings', 'shutdown', 'timeout']) {
    const started = deferred(); let signal: AbortSignal | undefined;
    const f = await fixture(t, async (_url, init) => {
      if (init?.method !== 'POST') return Response.json({ data: [{ id: 'test-chat' }] });
      signal = init.signal as AbortSignal; started.resolve(); return new Promise<Response>(() => {});
    }, { gatewayTimeoutMs: mode === 'timeout' ? 20 : 5000 });
    const response = openaiChat(f.text, input()); const rejected = assert.rejects(response, { code: mode === 'settings' ? 'TEXT_SETTINGS_CHANGED' : mode === 'shutdown' ? 'TEXT_STOPPING' : 'TEXT_TIMEOUT' });
    await started.promise;
    if (mode === 'settings') f.text.saveConnection({ revision: 1, baseUrl: 'http://changed.local/v1' });
    if (mode === 'shutdown') await f.text.close();
    await rejected; assert.equal(signal!.aborted, true);
  }
});

test('truncated, malformed and credential-bearing streams emit a safe error instead of a success sentinel', async t => {
  for (const upstream of [sse(chunk({ content: 'Partial' })), sse({ error: { message: secret } }), sse(chunk({ content: secret }), '[DONE]'), new Response('data: {broken}\n\n', { headers: { 'content-type': 'text/event-stream' } })]) {
    const f = await fixture(t, async (_url, init) => init?.method === 'POST' ? upstream : Response.json({ data: [{ id: 'test-chat' }] }));
    const response = await openaiChat(f.text, input({ stream: true })); const body = await response.text();
    assert.match(body, /"error":/); assert.equal(body.includes(secret), false); assert.equal(body.includes('[DONE]'), false);
  }
});
