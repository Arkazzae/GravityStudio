import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import { Store } from '../../apps/server/store.ts';
import { Engine } from '../../apps/server/engine.ts';
import { createStudioServer, type ServerOptions } from '../../apps/server/http.ts';
import { saveOutput } from '../../apps/server/media.ts';
import { createSession } from '../../apps/server/auth.ts';
import { PNG } from '../inference/fake-comfy.ts';
import { FakeObjectStore } from './helpers/fake-object-store.ts';
import { inventory, until } from './helpers/engine-fixture.ts';

const origin = 'http://localhost:4321';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t: TestContext, options: { objects?: FakeObjectStore; prepare?: (store: Store, userId: string) => Promise<void>; runtime?: ServerOptions['runtime'] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'gravity-http-remote-'));
  const objects = options.objects ?? new FakeObjectStore(), store = new Store(directory, { objectStore: objects });
  const owner = store.createOwner('owner', 'fixture-hash');
  const cookie = createSession(store, owner, false).split(';')[0];
  await options.prepare?.(store, owner.id);
  const engine = new Engine(store, { detect: async () => inventory() });
  const server = await createStudioServer({ store, engine, allowedOrigins: [origin], setupSecret: 'fixture-secret', runtime: options.runtime });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await server.closeOperations().catch(() => {}); await engine.stop();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); await rm(directory, { recursive: true, force: true });
  });
  const request = (path: string, init: RequestInit = {}) => fetch(`${url}${path}`, { ...init, headers: { Origin: origin, Cookie: cookie, ...init.headers } });
  return { store, owner, objects, engine, server, request };
}
async function completed(store: Store, userId: string) {
  const job = store.createJob(userId, { modelId: 'sdxl-base', prompt: 'Saved remote image' }, {}, [], 'SDXL', {}, randomUUID(), 'fixture');
  store.patchJob(job.id, { status: 'preparing' });
  const output = await saveOutput(store, job.id, 0, PNG);
  store.patchJob(job.id, { status: 'succeeded', outputs: [output] });
  return { job, output };
}

test('HTTP media keeps private URLs and validates ownership before fetching or deleting remote objects', async t => {
  const f = await fixture(t);
  const uploaded = await f.request('/api/inputs', { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-Filename': 'reference.png' }, body: Buffer.from(PNG) });
  assert.equal(uploaded.status, 201);
  const input = await uploaded.json();
  assert.equal(input.url, `/api/inputs/${input.id}`);
  assert.deepEqual(await (await f.request('/api/inputs')).json(), { inputs: [input] });
  const { job, output } = await completed(f.store, f.owner.id);
  for (const [url, expected] of [[input.url, f.objects.objects.get(f.store.input(input.id, f.owner.id).object!.key)], [output.url, Buffer.from(PNG)]] as const) {
    const response = await f.request(url);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
  const list = await (await f.request('/api/jobs')).text();
  for (const privateField of ['storeId', 'fixture/', '"object"', '"path"']) assert.equal(list.includes(privateField), false);
  const foreignId = randomUUID();
  f.store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(foreignId, 'other', 'fixture', new Date().toISOString());
  const foreignCookie = createSession(f.store, { id: foreignId, username: 'other' }, false).split(';')[0];
  const reads = f.objects.gets.length;
  for (const url of [input.url, output.url]) assert.equal((await f.request(url, { headers: { Cookie: foreignCookie } })).status, 404);
  assert.equal((await f.request(output.url, { method: 'DELETE', headers: { Cookie: foreignCookie } })).status, 404);
  assert.equal(f.objects.gets.length, reads); assert.equal(f.objects.deletes.length, 0);
  f.objects.failGet = true;
  const unavailable = await f.request(output.url);
  assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).error.code, 'ASSET_READ_FAILED');
  f.objects.failGet = false;
  assert.equal((await f.request(output.url, { method: 'DELETE' })).status, 200);
  assert.equal((await f.request(output.url)).status, 404);
  assert.deepEqual(f.store.job(job.id).outputs, []);
});

test('remote deletion recovery does not delay listening and shutdown waits for its active operation', async t => {
  const objects = new FakeObjectStore(), gate = deferred();
  let entered = false;
  objects.beforeDelete = async () => { entered = true; await gate.promise; };
  const f = await fixture(t, { objects, prepare: async (store, userId) => {
    const { job, output } = await completed(store, userId); store.beginOutputDeletion(job.id, output.id, userId);
  } });
  let drained = false;
  try {
    await until(() => entered);
    assert.equal((await f.request('/api/health')).status, 200);
    const shutdown = f.server.closeOperations().then(() => { drained = true; });
    await immediate(); assert.equal(drained, false);
    gate.resolve(); await shutdown;
    assert.deepEqual(f.store.pendingOutputDeletions(), []);
    assert.equal(objects.objects.size, 0);
  } finally { gate.resolve(); }
});

test('shutdown drains an accepted remote upload despite another subsystem failing, and rejects new uploads', async t => {
  const objects = new FakeObjectStore(), gate = deferred();
  let entered = false;
  const runtime = { status() { throw new Error('unused fixture'); }, start() { throw new Error('unused fixture'); }, async managedWorkers() { return []; }, async close() { throw new Error('fixture close failure'); } };
  const f = await fixture(t, { objects, runtime });
  objects.beforePut = async () => { entered = true; await gate.promise; };
  const upload = () => f.request('/api/inputs', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from(PNG) });
  const pending = upload();
  let drained = false;
  try {
    await until(() => entered);
    const shutdown = f.server.closeOperations().then(() => { drained = true; }, error => { drained = true; return error; });
    await immediate(); assert.equal(drained, false);
    assert.equal((await upload()).status, 503);
    gate.resolve();
    const response = await pending; assert.equal(response.status, 201);
    const input = await response.json();
    assert.equal(f.store.input(input.id, f.owner.id).object?.storeId, objects.id);
    assert.ok(await shutdown instanceof AggregateError);
  } finally { gate.resolve(); await pending; }
});
