import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../../apps/server/store.ts';
import { Engine } from '../../apps/server/engine.ts';
import { createStudioServer } from '../../apps/server/http.ts';
import { digest } from '../../apps/server/auth.ts';

const origin = 'http://localhost:4321';
async function fixture(t: TestContext, textFetch: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), 'gravity-text-http-'));
  const store = new Store(directory), engine = new Engine(store);
  const owner = store.createOwner('owner', 'unused');
  store.saveSession(digest('fixture-session'), owner.id, Date.now() + 60000);
  store.saveApiToken(owner.id, 'Image client', digest('fixture-api-token'));
  const server = await createStudioServer({ store, engine, allowedOrigins: [origin], setupSecret: 'fixture-setup', textFetch });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await server.closeOperations(); await engine.stop(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const cookie = 'gravity_session=fixture-session';
  const request = (path: string, method = 'GET', body?: unknown, signal?: AbortSignal) => fetch(`${base}${path}`, { method, signal, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { store, server, base, cookie, request };
}
const listed = () => Response.json({ data: [{ id: 'fixture-text' }] });

test('text inference and settings require the owner session; existing image API tokens have no paid text access', async t => {
  let calls = 0;
  const api = await fixture(t, async () => { calls++; return listed(); });
  for (const [path, method] of [['/text/settings', 'GET'], ['/text/models?provider=gemini', 'GET'], ['/text/local', 'GET'], ['/text/local', 'PUT'], ['/text/local', 'POST'], ['/text/local/unload', 'POST'], ['/text/connection', 'PUT'], ['/text/assistant', 'PUT'], ['/prompts/refine', 'POST']]) {
    const body = method === 'GET' ? undefined : '{}';
    assert.equal((await fetch(`${api.base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body })).status, 401);
    assert.equal((await fetch(`${api.base}${path}`, { method, headers: { Authorization: 'Bearer fixture-api-token', 'Content-Type': 'application/json' }, body })).status, 403);
    if (method !== 'GET') {
      assert.equal((await fetch(`${api.base}${path}`, { method, headers: { Cookie: api.cookie, 'Content-Type': 'application/json' }, body })).status, 403);
      assert.equal((await fetch(`${api.base}${path}`, { method, headers: { Cookie: api.cookie, Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body })).status, 403);
    }
  }
  assert.equal(calls, 0);
});

test('owner configures a text endpoint and refines with a pinned settings revision without exposing keys', async t => {
  let completions = 0;
  const api = await fixture(t, async (input, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-secret-5678');
    assert.equal(init?.redirect, 'error');
    if (String(input).endsWith('/models')) return listed();
    assert.equal(String(input), 'http://127.0.0.1:8080/v1/chat/completions');
    completions++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'fixture-text');
    assert.equal(body.stream, false);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ prompt: 'A ceramic teapot in warm evening light.' }) } }], usage: { prompt_tokens: 90, completion_tokens: 12 } });
  });
  const initial = await api.request('/text/settings');
  assert.equal(initial.status, 200); assert.equal(initial.headers.get('cache-control'), 'private, no-store');
  const settings = await initial.json();
  assert.equal(settings.assistant, null);
  const connected = await api.request('/text/connection', 'PUT', { revision: settings.revision, baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'fixture-secret-5678' });
  assert.equal(connected.status, 200);
  const connection = await connected.json();
  assert.equal(JSON.stringify(connection).includes('fixture-secret'), false);
  assert.equal(connection.connection.credential.suffix, '5678');
  assert.equal((await api.request('/text/models?provider=openai-compatible')).status, 200);
  const selected = await api.request('/text/assistant', 'PUT', { revision: connection.revision, provider: 'openai-compatible', modelId: 'fixture-text' });
  assert.equal(selected.status, 200);
  const current = await selected.json();
  const input = { settingsRevision: current.revision, imageModelId: 'sdxl-base', prompt: 'A ceramic teapot.', instruction: 'Use evening light.' };
  assert.equal((await api.request('/prompts/refine', 'POST', { ...input, settingsRevision: connection.revision })).status, 409);
  assert.equal(completions, 0, 'Stale settings cannot invoke a newly selected provider');
  const refined = await api.request('/prompts/refine', 'POST', input);
  assert.equal(refined.status, 200);
  const result = await refined.json();
  assert.equal(result.prompt, 'A ceramic teapot in warm evening light.');
  assert.equal(result.originalPrompt, input.prompt); assert.equal(result.modelId, 'fixture-text');
  assert.equal(result.provider, 'openai-compatible'); assert.equal(completions, 1);
  assert.equal(api.store.jobs().length, 0, 'Refining must not submit an image generation');
});

test('disconnecting the browser aborts the upstream refinement and frees its concurrency slot', async t => {
  let started!: () => void, aborted!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  let hang = true;
  const api = await fixture(t, async (input, init) => {
    if (String(input).endsWith('/models')) return listed();
    if (!hang) return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"prompt":"A teapot on a wooden table."}' } }] });
    started();
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => { aborted(); reject(init?.signal?.reason); };
      if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true });
    });
  });
  const saved = await (await api.request('/text/connection', 'PUT', { revision: 0, baseUrl: 'http://127.0.0.1:8080/v1' })).json();
  const selection = await (await api.request('/text/assistant', 'PUT', { revision: saved.revision, provider: 'openai-compatible', modelId: 'fixture-text' })).json();
  const input = { settingsRevision: selection.revision, imageModelId: 'sdxl-base', prompt: 'A teapot.' };
  const controller = new AbortController();
  const pending = api.request('/prompts/refine', 'POST', input, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await began;
  controller.abort(); await rejected; await cancelled;
  hang = false;
  assert.equal((await api.request('/prompts/refine', 'POST', input)).status, 200);
});
