import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../../apps/server/store.ts';
import { Engine } from '../../apps/server/engine.ts';
import { createStudioServer } from '../../apps/server/http.ts';
import { createSession } from '../../apps/server/auth.ts';
import { deleteInput, deleteOutput, inputBytes, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, saveInput, saveInputFromOutput, saveOutput } from '../../apps/server/media.ts';
import { PNG } from '../inference/fake-comfy.ts';
import { FakeObjectStore } from './helpers/fake-object-store.ts';
import { inventory, until } from './helpers/engine-fixture.ts';

const sharp = createRequire(new URL('../../apps/server/package.json', import.meta.url))('sharp');
const origin = 'http://localhost:4321';
async function fixture(t: TestContext, objects: FakeObjectStore | null = null) {
  const directory = await mkdtemp(join(tmpdir(), 'gravity-output-reference-'));
  let store = new Store(directory, { objectStore: objects });
  const owner = store.createOwner('owner', 'fixture');
  let server: Awaited<ReturnType<typeof createStudioServer>> | undefined;
  let engine: Engine | undefined;
  t.after(async () => {
    if (server) { await server.closeOperations(); await engine!.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    store.close(); await rm(directory, { recursive: true, force: true });
  });
  return {
    directory, owner, get store() { return store; },
    restart() { store.close(); store = new Store(directory, { objectStore: objects }); },
    async complete(bytes: Uint8Array = PNG) {
      const job = store.createJob(owner.id, { modelId: 'sdxl-base', prompt: 'Saved reference source' }, {}, [], 'SDXL', {}, randomUUID(), 'fixture');
      store.patchJob(job.id, { status: 'preparing' });
      const output = await saveOutput(store, job.id, 0, bytes);
      store.patchJob(job.id, { status: 'succeeded', outputs: [output] });
      return { jobId: job.id, outputId: output.id };
    },
    async serve() {
      engine = new Engine(store, { detect: async () => inventory() });
      server = await createStudioServer({ store, engine, allowedOrigins: [origin], setupSecret: 'fixture' });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const cookie = createSession(store, owner, false).split(';')[0];
      return { url, cookie, request: (path: string, init: RequestInit = {}) => fetch(`${url}${path}`, { ...init, headers: { Origin: origin, Cookie: cookie, ...init.headers } }) };
    },
  };
}

for (const remote of [false, true]) test(`${remote ? 'S3' : 'local'} saved-output references reuse one normalized input across concurrent requests and restart`, async t => {
  const objects = remote ? new FakeObjectStore() : null, f = await fixture(t, objects), source = await f.complete();
  const results = await Promise.all(Array.from({ length: 8 }, () => saveInputFromOutput(f.store, f.owner.id, source)));
  const input = results[0];
  for (const result of results) assert.deepEqual(result, input);
  assert.deepEqual(input.source, source);
  assert.deepEqual(f.store.inputs(f.owner.id), [input]);
  assert.equal(f.store.inputUploads.size, 0);
  const bytes = await inputBytes(f.store, input.id, f.owner.id);
  assert.ok(bytes.length);
  if (objects) assert.equal(objects.puts.filter(path => path.startsWith('inputs/')).length, 1);
  else assert.deepEqual(await readdir(join(f.directory, 'inputs')), [`${input.id}.png`]);
  f.restart();
  assert.deepEqual(await saveInputFromOutput(f.store, f.owner.id, source), input);
  for (const privateField of ['path', 'object', 'bytes', 'userId']) assert.equal(privateField in f.store.inputs(f.owner.id)[0], false);
  await deleteOutput(f.store, source.jobId, source.outputId, f.owner.id);
  assert.deepEqual(await inputBytes(f.store, input.id, f.owner.id), bytes, 'the independent reference remains usable when its original is removed');
  assert.deepEqual(f.store.inputs(f.owner.id), [input], 'the retained reference stays manageable through the normal asset API');
  await assert.rejects(saveInputFromOutput(f.store, f.owner.id, source), { code: 'OUTPUT_NOT_FOUND' });
  await deleteInput(f.store, input.id, f.owner.id);
  assert.deepEqual(f.store.inputs(f.owner.id), []);
  if (objects) assert.equal(objects.objects.size, 0);
});

test('saved-output references reject pending deletions and can be recreated after deleting their cached input', async t => {
  const f = await fixture(t), source = await f.complete();
  const input = await saveInputFromOutput(f.store, f.owner.id, source);
  f.store.beginInputDeletion(input.id, f.owner.id);
  await assert.rejects(saveInputFromOutput(f.store, f.owner.id, source), { code: 'INPUT_DELETION_PENDING' });
  await deleteInput(f.store, input.id, f.owner.id);
  const replacement = await saveInputFromOutput(f.store, f.owner.id, source);
  assert.notEqual(replacement.id, input.id);
  assert.deepEqual(f.store.inputs(f.owner.id), [replacement]);
  f.store.beginOutputDeletion(source.jobId, source.outputId, f.owner.id);
  await assert.rejects(saveInputFromOutput(f.store, f.owner.id, source), { code: 'OUTPUT_DELETION_PENDING' });
  assert.ok(await inputBytes(f.store, replacement.id, f.owner.id));
});

test('source deletion during normalization rejects the late commit and removes its unregistered object', async t => {
  const objects = new FakeObjectStore(), f = await fixture(t, objects), source = await f.complete();
  let release!: () => void, entered = false;
  const paused = new Promise<void>(resolve => { release = resolve; });
  objects.beforePut = async () => { entered = true; await paused; };
  const pending = saveInputFromOutput(f.store, f.owner.id, source);
  const rejected = assert.rejects(pending, { code: 'OUTPUT_NOT_FOUND' });
  try {
    await until(() => entered);
    assert.equal(f.store.inputUploads.get(f.owner.id), 1, 'account deletion sees the in-flight reference preparation');
    await deleteOutput(f.store, source.jobId, source.outputId, f.owner.id);
  } finally { release(); }
  await rejected;
  assert.deepEqual(f.store.inputs(f.owner.id), []);
  assert.equal(objects.objects.size, 0);
  assert.equal(f.store.inputUploads.size, 0);
  objects.beforePut = undefined;
  const next = await f.complete();
  assert.ok(await saveInputFromOutput(f.store, f.owner.id, next), 'a failed copy does not leave later requests locked');
});

test('saved images above the raw upload limit are normalized while ordinary uploads remain independent', async t => {
  const f = await fixture(t);
  const bytes: Buffer = await sharp({ create: { width: 3072, height: 3072, channels: 3, background: '#123456' } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(bytes.length > MAX_INPUT_BYTES && bytes.length <= MAX_OUTPUT_BYTES);
  await assert.rejects(saveInput(f.store, f.owner.id, bytes, 'large-upload.png'), { code: 'INPUT_TOO_LARGE' });
  const source = await f.complete(bytes), input = await saveInputFromOutput(f.store, f.owner.id, source);
  assert.equal(input.width, 3072); assert.equal(input.height, 3072);
  const first = await saveInput(f.store, f.owner.id, Buffer.from(PNG), 'upload.png');
  const second = await saveInput(f.store, f.owner.id, Buffer.from(PNG), 'upload.png');
  assert.notEqual(first.id, second.id, 'raw uploads keep their existing independent asset semantics');
  assert.equal(first.source, undefined); assert.equal(second.source, undefined);
});

test('HTTP output references validate source shape, authentication, ownership and origin before reading storage', async t => {
  const objects = new FakeObjectStore(), f = await fixture(t, objects), source = await f.complete();
  const { request, url, cookie } = await f.serve();
  const path = '/api/inputs/from-output';
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(source) };
  assert.equal((await fetch(`${url}${path}`, init)).status, 401);
  assert.equal((await fetch(`${url}${path}`, { ...init, headers: { ...init.headers, Cookie: cookie } })).status, 403);
  assert.equal((await request(path, { ...init, headers: { ...init.headers, Origin: 'https://other.example' } })).status, 403);
  const other = randomUUID();
  f.store.db.prepare('INSERT INTO users(id,username,password,created_at) VALUES(?,?,?,?)').run(other, 'other', 'fixture', new Date().toISOString());
  const foreignCookie = createSession(f.store, { id: other, username: 'other', role: 'user' }, false).split(';')[0];
  assert.equal((await request(path, { ...init, headers: { ...init.headers, Cookie: foreignCookie } })).status, 404);
  for (const bad of [{}, { jobId: source.jobId }, { ...source, url: 'https://example.org/image.png' }, { ...source, outputId: '../private' }, { ...source, jobId: 'not-a-uuid' }]) {
    const response = await request(path, { ...init, body: JSON.stringify(bad) });
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'INVALID_REFERENCE_SOURCE');
  }
  assert.equal(objects.gets.length, 0);
  const response = await request(path, init);
  assert.equal(response.status, 201);
  const input = await response.json();
  assert.deepEqual(input.source, source);
  assert.deepEqual(await (await request(path, init)).json(), input);
  assert.deepEqual(await (await request('/api/inputs')).json(), { inputs: [input] });
  assert.equal((await request(input.url)).status, 200);
  assert.equal(objects.puts.filter(location => location.startsWith('inputs/')).length, 1);
});
