import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { Store, publicJob } from '../../apps/server/store.ts';
import { Engine } from '../../apps/server/engine.ts';
import { createStudioServer, type ServerOptions } from '../../apps/server/http.ts';
import { digest } from '../../apps/server/auth.ts';
import type { ApiScope } from '../../packages/contracts/access.ts';
import { deleteInput, saveOutput } from '../../apps/server/media.ts';
import { engineFixture } from './helpers/engine-fixture.ts';
import { PNG } from '../inference/fake-comfy.ts';

const sharp = createRequire(new URL('../../apps/server/package.json', import.meta.url))('sharp') as typeof import('../../apps/server/node_modules/sharp/lib/index.d.ts');

const origin = 'http://localhost:4321', secret = 'fixture-provider-secret-5678';
const textModel = 'text/openai-compatible/org/fixture-chat';
const chatBody = (more: Record<string, unknown> = {}) => ({ model: textModel, messages: [{ role: 'user', content: 'Say hello' }], ...more });
const list = () => Response.json({ data: [{ id: 'org/fixture-chat' }] });
const completion = () => Response.json({ id: 'chatcmpl-fixture', created: 7, model: 'org/fixture-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
const sseEvent = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: 'chatcmpl-fixture', created: 7, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fakeLocal(run?: NonNullable<ServerOptions['localText']>['run']): NonNullable<ServerOptions['localText']> {
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected local configuration call'); };
  return { initialize: async () => {}, status: unsupported, prepare: unsupported, configure: unsupported, release: unsupported, models: async () => ({ provider: 'local', models: run ? [{ id: 'mimo', name: 'MiMo' }] : [] }), run: run ?? unsupported, evictIdle: async () => false, close: async () => {} };
}
async function fixture(t: TestContext, textFetch: typeof fetch = async (_input, init) => init?.method === 'POST' ? completion() : list(), localText = fakeLocal()) {
  const directory = await mkdtemp(join(tmpdir(), 'gravity-openai-http-'));
  const store = new Store(directory), engine = new Engine(store), owner = store.createOwner('owner', 'unused');
  store.saveSession(digest('fixture-session'), owner.id, Date.now() + 60_000);
  const server = await createStudioServer({ store, engine, allowedOrigins: [origin], setupSecret: 'fixture-setup', textFetch, localText });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await server.closeOperations(); await engine.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = (scopes: readonly ApiScope[], userId = owner.id, expiresAt: string | null = null) => { const key = `fixture-client-${randomUUID()}`; const record = store.saveApiToken(userId, 'Fixture client', digest(key), { scopes, expiresAt }); return { key, record }; };
  const request = (path: string, options: { key?: string; method?: string; body?: unknown; signal?: AbortSignal; headers?: HeadersInit } = {}) => fetch(`${base}${path}`, { method: options.method ?? (options.body === undefined ? 'GET' : 'POST'), signal: options.signal, headers: { ...(options.key ? { Authorization: `Bearer ${options.key}` } : {}), ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  const session = (path: string, method = 'GET', body?: unknown) => request(path, { method, body, headers: { Origin: origin, Cookie: 'gravity_session=fixture-session' } });
  const connect = async () => {
    const response = await session('/api/text/connection', 'PUT', { revision: 0, baseUrl: 'http://127.0.0.1:8080/v1', apiKey: secret }); assert.equal(response.status, 200);
    const selected = await session('/api/text/assistant', 'PUT', { revision: 1, provider: 'openai-compatible', modelId: 'org/fixture-chat' }); assert.equal(selected.status, 200);
  };
  return { store, engine, owner, base, server, token, request, session, connect };
}
async function compatibleError(response: Response, status: number, code?: string) {
  assert.equal(response.status, status); const result = await response.json();
  assert.equal(typeof result.error.message, 'string'); assert.equal(typeof result.error.type, 'string'); assert.equal(result.error.param, null);
  if (code) assert.equal(result.error.code, code);
  assert.equal(JSON.stringify(result).includes(secret), false); return result.error;
}

async function imageFixture(t: TestContext) {
  const f = await engineFixture(); f.engine.ticking = true;
  const server = await createStudioServer({ store: f.store, engine: f.engine, allowedOrigins: [origin], setupSecret: 'fixture-setup', localText: fakeLocal() });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await server.closeOperations(); await new Promise<void>(resolve => server.close(() => resolve())); f.engine.ticking = false; await f.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = (scopes: readonly ApiScope[]) => { const key = `fixture-image-${randomUUID()}`; f.store.saveApiToken(f.owner.id, 'Fixture image client', digest(key), { scopes, expiresAt: null }); return key; };
  let finish = true; const submit = f.engine.submit.bind(f.engine);
  f.engine.submit = async (userId, input, key) => {
    const job = await submit(userId, input, key); if (job.status !== 'queued' || !finish) return job;
    f.store.patchJob(job.id, { status: 'preparing' }); f.store.patchJob(job.id, { status: 'running' });
    const output = await saveOutput(f.store, job.id, 0, PNG);
    return publicJob(f.store.patchJob(job.id, { status: 'succeeded', outputs: [f.store.output(job.id, output.id, userId)] }));
  };
  const post = (path: string, key: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { ...f, base, token, post, queued: () => { finish = false; } };
}

test('OpenAI routes require authentication and narrowly scoped tokens on both base URLs', { timeout: 15_000 }, async t => {
  let requests = 0; const api = await fixture(t, async () => { requests++; return list(); });
  const models = api.token(['models:read']), chat = api.token(['text:generate']), expired = api.token(['models:read', 'text:generate'], api.owner.id, new Date(Date.now() - 1000).toISOString());
  for (const prefix of ['/v1', '/api/v1']) {
    await compatibleError(await api.request(`${prefix}/models`), 401);
    await compatibleError(await api.request(`${prefix}/chat/completions`, { body: chatBody() }), 401);
    await compatibleError(await api.request(`${prefix}/chat/completions`, { key: models.key, body: chatBody() }), 403);
    await compatibleError(await api.request(`${prefix}/models`, { key: chat.key }), 403);
    await compatibleError(await api.request(`${prefix}/models`, { key: expired.key }), 401);
    await compatibleError(await api.request(`${prefix}/chat/completions`, { body: chatBody(), headers: { Cookie: 'gravity_session=fixture-session' } }), 403);
    await compatibleError(await api.request(`${prefix}/models`, { key: models.key, headers: { Origin: 'https://untrusted.example' } }), 403);
  }
  assert.equal(requests, 0, 'Rejected clients never discover providers or invoke paid inference');
});

test('OpenAI model list and retrieval combine Studio image models with namespaced text models and a selected alias', { timeout: 15_000 }, async t => {
  const api = await fixture(t); await api.connect(); const { key } = api.token(['models:read']);
  for (const prefix of ['/v1', '/api/v1']) {
    const response = await api.request(`${prefix}/models`, { key }); assert.equal(response.status, 200);
    const catalog = await response.json(); assert.equal(catalog.object, 'list'); assert(Array.isArray(catalog.data));
    assert(catalog.data.some((model: { id: string }) => model.id === 'sdxl-base'));
    assert(catalog.data.some((model: { id: string }) => model.id === textModel));
    assert(catalog.data.some((model: { id: string }) => model.id === 'studio-assistant'));
    assert.equal(JSON.stringify(catalog).includes(secret), false); assert.equal(JSON.stringify(catalog).includes('127.0.0.1:8080'), false);
    const detail = await api.request(`${prefix}/models/${encodeURIComponent(textModel)}`, { key }); assert.equal(detail.status, 200); assert.equal((await detail.json()).id, textModel);
    const nested = await api.request(`${prefix}/models/${textModel}`, { key }); assert.equal(nested.status, 200); assert.equal((await nested.json()).id, textModel);
    await compatibleError(await api.request(`${prefix}/models/missing-model`, { key }), 404);
  }
});

test('OpenAI JSON and SSE chat routes preserve function calls, usage and aliases without billing local GPU time', { timeout: 15_000 }, async t => {
  const received: Record<string, unknown>[] = [];
  const api = await fixture(t, async (url, init) => {
    assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`);
    if (init?.method !== 'POST') return list();
    assert.equal(String(url), 'http://127.0.0.1:8080/v1/chat/completions'); const body = JSON.parse(String(init.body)); received.push(body);
    if (!body.stream) return completion();
    return new Response(sseEvent({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-fixture', type: 'function', function: { name: 'weather', arguments: '{}' } }] }, 'tool_calls') + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  await api.connect(); const { key } = api.token(['text:generate']);
  const result = await api.request('/v1/chat/completions', { key, body: chatBody({ model: 'studio-assistant', max_tokens: 500 }) }); assert.equal(result.status, 200);
  const body = await result.json(); assert.equal(body.object, 'chat.completion'); assert.equal(body.model, 'studio-assistant'); assert.equal(body.choices[0].message.content, 'Hello'); assert.equal(body.usage.total_tokens, 4);
  const tools = [{ type: 'function', function: { name: 'weather', parameters: { type: 'object', properties: {} } } }];
  const stream = await api.request('/api/v1/chat/completions', { key, body: chatBody({ stream: true, stream_options: { include_usage: true }, tools, tool_choice: 'required' }) }); assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type')!, /text\/event-stream/); assert.match(stream.headers.get('cache-control')!, /no-store/); assert.equal(stream.headers.get('x-accel-buffering'), 'no');
  const events = await stream.text(); assert.match(events, /"tool_calls"/); assert.match(events, /"total_tokens":4/); assert.match(events, /data: \[DONE\]/); assert.equal(events.includes(secret), false);
  assert.deepEqual(received[1].tools, tools); assert.equal(received[1].model, 'org/fixture-chat'); assert.equal(received.length, 2);
  assert.equal(api.engine.workTime.view(api.owner.id).balance.activeTasks, 0); assert.equal(api.engine.workTime.view(api.owner.id).balance.usedMs, 0); assert.equal(api.store.jobs().length, 0);
});

test('OpenAI errors use the compatible envelope for malformed JSON, unsupported fields, wrong models and provider failures', { timeout: 15_000 }, async t => {
  let posts = 0; const api = await fixture(t, async (_url, init) => { if (init?.method !== 'POST') return list(); posts++; return new Response(`private provider error ${secret}`, { status: 401 }); });
  await api.connect(); const { key } = api.token(['text:generate', 'models:read']);
  await compatibleError(await fetch(`${api.base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: '{bad' }), 400);
  await compatibleError(await api.request('/api/v1/chat/completions', { key, body: chatBody({ messages: [] }) }), 400, 'INVALID_CHAT_REQUEST');
  await compatibleError(await api.request('/v1/chat/completions', { key, body: chatBody({ apiKey: 'injected-secret' }) }), 400, 'INVALID_CHAT_REQUEST');
  await compatibleError(await api.request('/v1/chat/completions', { key, body: chatBody({ model: 'sdxl-base' }) }), 404, 'TEXT_MODEL_UNAVAILABLE');
  assert.equal(posts, 0);
  await compatibleError(await api.request('/v1/chat/completions', { key, body: chatBody() }), 502, 'TEXT_ACCESS_DENIED'); assert.equal(posts, 1);
});

test('bearer prompt refinement resolves the current revision while browser requests retain stale-settings protection', { timeout: 15_000 }, async t => {
  let posts = 0;
  const api = await fixture(t, async (_url, init) => {
    if (init?.method !== 'POST') return list(); posts++;
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ prompt: 'A ceramic cup in warm evening light.' }) } }] });
  });
  await api.connect(); const { key } = api.token(['text:generate']); const body = { prompt: 'A ceramic cup', imageModelId: 'sdxl-base' };
  const response = await api.request('/api/prompts/refine', { key, body }); assert.equal(response.status, 200); assert.equal((await response.json()).prompt, 'A ceramic cup in warm evening light.');
  const stale = await api.request('/api/prompts/refine', { key, body: { ...body, settingsRevision: 0 } }); assert.equal(stale.status, 409); assert.equal((await stale.json()).error.code, 'TEXT_SETTINGS_CHANGED');
  const browser = await api.session('/api/prompts/refine', 'POST', body); assert.equal(browser.status, 400); assert.equal((await browser.json()).error.code, 'INVALID_TEXT_SETTINGS');
  assert.equal(posts, 1);
});

test('bearer prompt refinement rechecks authorization after provider discovery', { timeout: 15_000 }, async t => {
  const discovering = deferred(), release = deferred(); let delayDiscovery = false, posts = 0;
  const api = await fixture(t, async (_url, init) => {
    if (init?.method === 'POST') { posts++; return completion(); }
    if (delayDiscovery) { discovering.resolve(); await release.promise; } return list();
  });
  t.after(release.resolve);
  await api.connect(); delayDiscovery = true;
  assert.equal((await api.session('/api/text/connection', 'PUT', { revision: 2, baseUrl: 'http://127.0.0.1:8080/v1' })).status, 200);
  const { key, record } = api.token(['text:generate']);
  const pending = api.request('/api/prompts/refine', { key, body: { prompt: 'A ceramic cup', imageModelId: 'sdxl-base' } });
  await discovering.promise; api.store.revokeApiToken(api.owner.id, record.id); release.resolve();
  const response = await pending; assert.equal(response.status, 401); assert.equal((await response.json()).error.code, 'UNAUTHENTICATED'); assert.equal(posts, 0);
});

test('HTTP chat disconnection cancels upstream inference and permits a following request', { timeout: 15_000 }, async t => {
  const began = deferred(), aborted = deferred(); let hang = true;
  const api = await fixture(t, async (_url, init) => {
    if (init?.method !== 'POST') return list(); if (!hang) return completion();
    began.resolve(); return new Promise<Response>((_resolve, reject) => { const cancel = () => { aborted.resolve(); reject(init?.signal?.reason); }; if (init?.signal?.aborted) cancel(); else init?.signal?.addEventListener('abort', cancel, { once: true }); });
  });
  await api.connect(); const { key } = api.token(['text:generate']); const controller = new AbortController();
  const pending = api.request('/v1/chat/completions', { key, body: chatBody(), signal: controller.signal }); const rejected = assert.rejects(pending, { name: 'AbortError' });
  await began.promise; controller.abort(); await rejected; await aborted.promise; hang = false;
  assert.equal((await api.request('/v1/chat/completions', { key, body: chatBody() })).status, 200);
});

test('revoked tokens and disabled accounts cannot invoke a provider after delayed model discovery', { timeout: 15_000 }, async t => {
  for (const change of ['revoke', 'disable']) {
    const discovering = deferred(), release = deferred(); let posts = 0;
    const api = await fixture(t, async (_url, init) => {
      if (init?.method === 'POST') { posts++; return completion(); }
      discovering.resolve(); await release.promise; return list();
    });
    t.after(release.resolve);
    assert.equal((await api.session('/api/text/connection', 'PUT', { revision: 0, baseUrl: 'http://127.0.0.1:8080/v1' })).status, 200);
    const { key, record } = api.token(['text:generate']);
    const pending = api.request('/v1/chat/completions', { key, body: chatBody() });
    await discovering.promise;
    if (change === 'revoke') api.store.revokeApiToken(api.owner.id, record.id);
    else api.store.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(api.owner.id);
    release.resolve(); await compatibleError(await pending, change === 'revoke' ? 401 : 403);
    assert.equal(posts, 0, 'Provider authorization must be rechecked immediately before inference');
  }
});

test('disconnecting an active HTTP SSE response cancels the provider and ends local work time', { timeout: 15_000 }, async t => {
  const cancelled = deferred(); let providerSignal: AbortSignal | undefined;
  const local = fakeLocal(async (_modelId, _signal, work, admitted) => { admitted?.(); return work({ provider: 'openai-compatible', baseUrl: 'http://managed.local/v1' }, { id: 'mimo', name: 'MiMo' }); });
  const api = await fixture(t, async (_url, init) => {
    providerSignal = init?.signal as AbortSignal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sseEvent({ role: 'assistant', content: 'Hello' }))); }, cancel() { cancelled.resolve(); } }), { headers: { 'content-type': 'text/event-stream' } });
  }, local);
  const { key } = api.token(['text:generate']);
  const response = await api.request('/v1/chat/completions', { key, body: chatBody({ model: 'text/local/mimo', stream: true }) });
  assert.equal(response.status, 200); assert.equal(api.engine.workTime.view(api.owner.id).balance.activeTasks, 1);
  await response.body!.cancel(); await cancelled.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(providerSignal!.aborted, true); assert.equal(api.engine.workTime.view(api.owner.id).balance.activeTasks, 0);
});

test('local OpenAI chat enforces member time allowance at request and admission, then meters the full streamed request', { timeout: 15_000 }, async t => {
  let runtimeCalls = 0, admissionHook: (() => void) | undefined, releaseStream: (() => void) | undefined;
  const local = fakeLocal(async (_modelId, _signal, work, admitted) => { runtimeCalls++; admissionHook?.(); admitted?.(); return work({ provider: 'openai-compatible', baseUrl: 'http://managed.local/v1', apiKey: secret }, { id: 'mimo', name: 'MiMo', outputTokenLimit: 2048 }); });
  const api = await fixture(t, async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).model, 'mimo');
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sseEvent({ role: 'assistant', content: 'Hello' }))); releaseStream = () => { controller.enqueue(new TextEncoder().encode(sseEvent({}, 'stop') + 'data: [DONE]\n\n')); controller.close(); }; } }), { headers: { 'content-type': 'text/event-stream' } });
  }, local);
  const memberId = randomUUID(); api.store.db.prepare('INSERT INTO users(id,username,password,created_at) VALUES(?,?,?,?)').run(memberId, 'member', 'unused', new Date().toISOString());
  const { key } = api.token(['models:read', 'text:generate'], memberId); const body = chatBody({ model: 'text/local/mimo', stream: true });
  await compatibleError(await api.request('/v1/chat/completions', { key, body }), 403, 'SERVER_TIME_EXHAUSTED'); assert.equal(runtimeCalls, 0);
  api.engine.workTime.adjust(api.owner.id, memberId, 60_000, 'Fixture allowance', 'gateway-grant-one');
  admissionHook = () => { api.engine.workTime.adjust(api.owner.id, memberId, -60_000, 'Revoke before admission', 'gateway-revoke-one'); };
  await compatibleError(await api.request('/v1/chat/completions', { key, body }), 403, 'SERVER_TIME_EXHAUSTED'); assert.equal(runtimeCalls, 1); assert.equal(api.engine.workTime.view(memberId).balance.activeTasks, 0);
  admissionHook = undefined; api.engine.workTime.adjust(api.owner.id, memberId, 60_000, 'Fixture allowance', 'gateway-grant-two');
  const streamed = await api.request('/api/v1/chat/completions', { key, body }); assert.equal(streamed.status, 200); assert.equal(api.engine.workTime.view(memberId).balance.activeTasks, 1);
  releaseStream!(); assert.match(await streamed.text(), /\[DONE\]/); await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.engine.workTime.view(memberId).balance.activeTasks, 0); assert.equal(api.engine.workTime.view(memberId).sessions.length, 1); assert.equal(runtimeCalls, 2);
});

test('OpenAI image files support scoped upload, idempotent retries, metadata, binary reads and owned deletion', { timeout: 15_000 }, async t => {
  const api = await fixture(t), full = api.token(['assets:read', 'assets:write', 'assets:delete']), read = api.token(['assets:read']);
  const pixels = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#c4df50' } }).png().toBuffer();
  const form = new FormData(); form.set('purpose', 'vision'); form.set('file', new File([new Uint8Array(pixels)], 'reference.png', { type: 'image/png' }));
  const upload = (key: string, requestKey = 'fixture-upload-one') => fetch(`${api.base}/v1/files`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Idempotency-Key': requestKey }, body: form });
  await compatibleError(await upload(read.key), 403); assert.equal(api.store.inputs(api.owner.id).length, 0);
  const response = await upload(full.key); assert.equal(response.status, 200); const file = await response.json();
  assert.equal(file.object, 'file'); assert.equal(file.purpose, 'vision'); assert.equal(file.filename, 'reference.png'); assert(file.bytes > 0);
  const retried = await upload(full.key); assert.equal(retried.status, 200); assert.equal((await retried.json()).id, file.id); assert.equal(api.store.inputs(api.owner.id).length, 1);
  for (const prefix of ['/v1', '/api/v1']) {
    const list = await api.request(`${prefix}/files`, { key: read.key }); assert.equal(list.status, 200); assert.equal((await list.json()).data[0].id, file.id);
    const detail = await api.request(`${prefix}/files/${file.id}`, { key: read.key }); assert.equal(detail.status, 200); assert.equal((await detail.json()).filename, 'reference.png');
    const image = await api.request(`${prefix}/files/${file.id}/content`, { key: read.key }); assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
    const metadata = await sharp(Buffer.from(await image.arrayBuffer())).metadata(); assert.equal(metadata.width, 32); assert.equal(metadata.height, 24);
  }
  const otherId = randomUUID(); api.store.db.prepare('INSERT INTO users(id,username,password,created_at) VALUES(?,?,?,?)').run(otherId, 'other', 'unused', new Date().toISOString());
  const other = api.token(['assets:read', 'assets:delete'], otherId);
  await compatibleError(await api.request(`/v1/files/${file.id}`, { key: other.key }), 404);
  await compatibleError(await api.request(`/v1/files/${file.id}/content`, { key: other.key }), 404);
  await compatibleError(await api.request(`/v1/files/${file.id}`, { key: other.key, method: 'DELETE' }), 404);
  await compatibleError(await api.request(`/v1/files/${file.id}`, { key: read.key, method: 'DELETE' }), 403);
  const deleted = await api.request(`/api/v1/files/${file.id}`, { key: full.key, method: 'DELETE' }); assert.equal(deleted.status, 200); assert.deepEqual(await deleted.json(), { id: file.id, object: 'file', deleted: true });
  await compatibleError(await api.request(`/v1/files/${file.id}`, { key: read.key }), 404);
  await compatibleError(await upload(full.key), 409, 'REFERENCE_DELETED'); assert.equal(api.store.inputs(api.owner.id).length, 0);
});

test('OpenAI image HTTP generation returns base64 or expiring URLs and replays completed batches', { timeout: 15_000 }, async t => {
  const api = await imageFixture(t), key = api.token(['jobs:write', 'assets:read']);
  const body = { model: 'sdxl-base', prompt: 'A ceramic cup', size: '1024x1024', n: 2, studio: { seed: 42 } };
  const headers = { 'Idempotency-Key': 'http-image-batch' };
  const response = await api.post('/v1/images/generations', key, body, headers); assert.equal(response.status, 200);
  const images = await response.json(); assert.equal(images.data.length, 2); assert.deepEqual(Buffer.from(images.data[0].b64_json, 'base64'), Buffer.from(PNG));
  const ids = response.headers.get('x-gravity-job-ids')!.split(','); assert.equal(ids.length, 2); assert.equal(response.headers.get('location'), `/api/jobs/${ids[0]}`);
  const repeated = await api.post('/api/v1/images/generations', key, body, headers); assert.equal(repeated.status, 200); assert.deepEqual(await repeated.json(), images); assert.equal(api.store.jobs(api.owner.id).length, 2);
  await compatibleError(await api.post('/v1/images/generations', key, { ...body, prompt: 'Different' }, headers), 409, 'IDEMPOTENCY_CONFLICT');
  const linked = await api.post('/v1/images/generations', key, { ...body, n: 1, response_format: 'url', output_format: 'webp' }, { 'Idempotency-Key': 'http-image-link', 'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'https' });
  assert.equal(linked.status, 200); const url = new URL((await linked.json()).data[0].url); assert.equal(url.origin, origin, 'An untrusted forwarded host cannot change download destinations');
  const download = await fetch(`${api.base}${url.pathname}`); assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'image/webp'); assert.equal((await sharp(Buffer.from(await download.arrayBuffer())).metadata()).format, 'webp');
  api.store.db.prepare('UPDATE api_downloads SET expires_at=?').run(Date.now() - 1); assert.equal((await fetch(`${api.base}${url.pathname}`)).status, 404);
});

test('OpenAI async image HTTP responses expose durable jobs and preserve them across retries', { timeout: 15_000 }, async t => {
  const api = await imageFixture(t); api.queued(); const writeOnly = api.token(['jobs:write']), key = api.token(['jobs:write', 'jobs:read', 'assets:read']);
  const body = { model: 'sdxl-base', prompt: 'A ceramic cup' }, headers = { Prefer: 'respond-async', 'Idempotency-Key': 'http-async-image' };
  await compatibleError(await api.post('/api/v1/images/generations', writeOnly, body, headers), 403); assert.equal(api.store.jobs(api.owner.id).length, 0);
  const response = await api.post('/api/v1/images/generations', key, body, headers); assert.equal(response.status, 202); const accepted = await response.json();
  assert.equal(accepted.jobs.length, 1); assert.equal(accepted.jobs[0].status, 'queued'); assert.deepEqual(accepted.data, []);
  assert.equal(response.headers.get('location'), `/api/jobs/${accepted.jobs[0].id}`);
  const polled = await fetch(`${api.base}${response.headers.get('location')}`, { headers: { Authorization: `Bearer ${key}` } }); assert.equal(polled.status, 200); assert.equal((await polled.json()).job.id, accepted.jobs[0].id);
  const retry = await api.post('/v1/images/generations', key, body, headers); assert.equal(retry.status, 202); assert.equal((await retry.json()).jobs[0].id, accepted.jobs[0].id); assert.equal(api.store.jobs(api.owner.id).length, 1);
});

test('OpenAI multipart image HTTP edits require upload permission and deduplicate reference imports on retries', { timeout: 15_000 }, async t => {
  const api = await imageFixture(t), readWriteJobs = api.token(['jobs:write', 'assets:read']), key = api.token(['jobs:write', 'assets:read', 'assets:write']);
  const form = new FormData(); form.set('model', 'sdxl-base'); form.set('prompt', 'Keep the composition, use evening light'); form.set('studio', '{"denoise":0.4}'); form.set('image', new File([PNG], 'reference.png', { type: 'image/png' }));
  const post = (key: string) => fetch(`${api.base}/api/v1/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Idempotency-Key': 'http-edit-image' }, body: form });
  await compatibleError(await post(readWriteJobs), 403); assert.equal(api.store.inputs(api.owner.id).length, 0);
  const first = await post(key); assert.equal(first.status, 200); const ids = first.headers.get('x-gravity-job-ids');
  const repeated = await post(key); assert.equal(repeated.status, 200); assert.equal(repeated.headers.get('x-gravity-job-ids'), ids);
  assert.equal(api.store.inputs(api.owner.id).length, 1); assert.equal(api.store.jobs(api.owner.id).length, 1);
  const input = api.store.jobs(api.owner.id)[0].input; assert.equal(input.operation, 'image-to-image'); assert.deepEqual('images' in input && input.images, [api.store.inputs(api.owner.id)[0].id]);
  await deleteInput(api.store, api.store.inputs(api.owner.id)[0].id, api.owner.id);
  const recovered = await post(key); assert.equal(recovered.status, 200); assert.equal(recovered.headers.get('x-gravity-job-ids'), ids);
  assert.equal(api.store.inputs(api.owner.id).length, 0, 'Replaying a completed edit does not recreate a deliberately deleted reference');
});
