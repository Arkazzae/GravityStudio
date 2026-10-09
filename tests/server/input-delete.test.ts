import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../../apps/server/store.ts';
import { Engine } from '../../apps/server/engine.ts';
import { createStudioServer } from '../../apps/server/http.ts';
import { createSession, digest } from '../../apps/server/auth.ts';
import { deleteInput, inputBytes, recoverInputDeletions, saveInput } from '../../apps/server/media.ts';
import { migrateAssets, storageStatus } from '../../apps/server/storage-migration.ts';
import { FakeObjectStore } from './helpers/fake-object-store.ts';
import { engineFixture, inventory, until } from './helpers/engine-fixture.ts';
import { PNG } from '../inference/fake-comfy.ts';

const origin = 'http://localhost:4321';
async function fixture(t: TestContext, objects: FakeObjectStore | null = null) {
  const directory = await mkdtemp(join(tmpdir(), 'gravity-input-delete-'));
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
    restart(next = objects) { store.close(); store = new Store(directory, { objectStore: next }); },
    upload: () => saveInput(store, owner.id, Buffer.from(PNG), 'reference.png'),
    job: (id: string) => store.createJob(owner.id, { modelId: 'sdxl-base', prompt: 'Keep generation history', images: [id] }, {}, [], 'SDXL', {}, randomUUID(), 'fixture'),
    async serve() {
      engine = new Engine(store, { detect: async () => inventory() });
      server = await createStudioServer({ store, engine, allowedOrigins: [origin], setupSecret: 'fixture' });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const cookie = createSession(store, owner, false).split(';')[0];
      return { server, url, cookie, request: (path: string, init: RequestInit = {}) => fetch(`${url}${path}`, { ...init, headers: { Origin: origin, Cookie: cookie, ...init.headers } }) };
    },
  };
}

test('input deletion protects every resumable job and preserves completed generation history', async t => {
  const f = await fixture(t);
  for (const state of ['queued', 'preparing', 'running', 'interrupted'] as const) {
    const input = await f.upload(), job = f.job(input.id);
    if (state !== 'queued') f.store.patchJob(job.id, { status: 'preparing' });
    if (state === 'running') f.store.patchJob(job.id, { status: 'running' });
    if (state === 'interrupted') f.store.patchJob(job.id, { status: 'interrupted' });
    await assert.rejects(deleteInput(f.store, input.id, f.owner.id), { status: 409, code: 'INPUT_IN_USE' });
    assert.ok((await inputBytes(f.store, input.id, f.owner.id)).length);
    assert.deepEqual(f.store.pendingInputDeletions(), []);
    f.store.patchJob(job.id, { status: state === 'queued' ? 'cancelled' : 'failed' });
    const original = f.store.job(job.id);
    await deleteInput(f.store, input.id, f.owner.id);
    assert.deepEqual(f.store.job(job.id), original);
    assert.throws(() => f.store.input(input.id, f.owner.id), { code: 'INPUT_NOT_FOUND' });
  }
  const input = await f.upload(), job = f.job(input.id);
  f.store.patchJob(job.id, { status: 'preparing' });
  f.store.patchJob(job.id, { status: 'succeeded' });
  const original = f.store.job(job.id);
  await deleteInput(f.store, input.id, f.owner.id);
  assert.deepEqual(f.store.job(job.id), original);
});

test('remote failure retains input metadata and deletion intent, blocks new references and recovers after restart', async t => {
  const objects = new FakeObjectStore(), f = await fixture(t, objects);
  const input = await f.upload(), original = f.store.input(input.id, f.owner.id);
  objects.failDelete = true;
  await assert.rejects(deleteInput(f.store, input.id, f.owner.id), { status: 503, code: 'INPUT_DELETE_FAILED' });
  assert.deepEqual(f.store.inputs(f.owner.id), [input]);
  assert.deepEqual(f.store.input(input.id, f.owner.id), original);
  assert.throws(() => f.job(input.id), { code: 'INPUT_DELETION_PENDING', status: 409 });
  assert.equal(f.store.activeJobs().length, 0);
  f.restart(); objects.failDelete = false;
  await recoverInputDeletions(f.store);
  assert.deepEqual(f.store.inputs(f.owner.id), []);
  assert.deepEqual(f.store.pendingInputDeletions(), []);
  assert.equal(objects.objects.size, 0);
});

for (const remote of [false, true]) test(`${remote ? 'S3' : 'local'} input deletion resumes after bytes are removed but the database commit fails`, async t => {
  const objects = remote ? new FakeObjectStore() : null, f = await fixture(t, objects);
  const input = await f.upload(), original = f.store.input(input.id, f.owner.id);
  f.store.db.exec("CREATE TRIGGER fixture_input_delete_failure BEFORE DELETE ON inputs BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END");
  await assert.rejects(deleteInput(f.store, input.id, f.owner.id), /fixture commit failure/);
  assert.deepEqual(f.store.input(input.id, f.owner.id), original);
  assert.equal(f.store.pendingInputDeletions().length, 1);
  if (objects) assert.equal(objects.objects.size, 0);
  else await assert.rejects(readFile(original.path!), { code: 'ENOENT' });
  f.restart(); f.store.db.exec('DROP TRIGGER fixture_input_delete_failure');
  await recoverInputDeletions(f.store);
  assert.deepEqual(f.store.inputs(f.owner.id), []);
  assert.deepEqual(f.store.pendingInputDeletions(), []);
});

test('input migration skips durable deletion intents and deletion removes both migrated storage copies', async t => {
  const f = await fixture(t), objects = new FakeObjectStore();
  const removed = await f.upload(), retained = await f.upload();
  f.store.beginInputDeletion(removed.id, f.owner.id);
  f.restart(objects);
  const result = await migrateAssets(f.store);
  assert.equal(result.skippedDeletions, 1); assert.equal(result.migrated, 1);
  assert.equal(storageStatus(f.store.db).pendingDeletions, 1);
  const migrated = f.store.input(retained.id, f.owner.id);
  assert.ok(migrated.object); assert.ok(migrated.path);
  await deleteInput(f.store, retained.id, f.owner.id);
  await assert.rejects(readFile(migrated.path!), { code: 'ENOENT' });
  assert.equal(objects.objects.size, 0);
  await recoverInputDeletions(f.store);
  assert.deepEqual(f.store.inputs(f.owner.id), []);
});

test('input deletion refuses a different asset object key, local path or symlink', async t => {
  const f = await fixture(t), input = await f.upload(), saved = f.store.input(input.id, f.owner.id);
  const other = join(f.directory, 'keep.png'); await writeFile(other, PNG);
  const update = (value: unknown) => f.store.db.prepare('UPDATE inputs SET body=? WHERE id=?').run(JSON.stringify(value), input.id);
  update({ ...saved, path: other });
  await assert.rejects(deleteInput(f.store, input.id, f.owner.id), { code: 'INPUT_DELETE_FAILED' });
  update(saved); await rm(saved.path!); await symlink(other, saved.path!);
  await assert.rejects(deleteInput(f.store, input.id, f.owner.id), { code: 'INPUT_DELETE_FAILED' });
  assert.deepEqual(await readFile(other), Buffer.from(PNG));
  const objects = new FakeObjectStore(), remote = await fixture(t, objects);
  const first = await remote.upload(), second = await remote.upload();
  remote.store.db.prepare('UPDATE inputs SET body=? WHERE id=?').run(JSON.stringify({ ...remote.store.input(first.id, remote.owner.id), object: remote.store.input(second.id, remote.owner.id).object }), first.id);
  await assert.rejects(deleteInput(remote.store, first.id, remote.owner.id), { code: 'INPUT_DELETE_FAILED' });
  assert.equal(objects.deletes.length, 0); assert.equal(objects.objects.size, 2);
});

test('submission rechecks input deletion after asynchronous worker discovery', async t => {
  const f = await engineFixture(); t.after(() => f.close());
  const input = await saveInput(f.store, f.owner.id, Buffer.from(PNG), 'reference.png');
  const originalRefresh = f.engine.refreshWorkers.bind(f.engine);
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  let reached = false;
  f.engine.refreshWorkers = async () => { reached = true; await paused; await originalRefresh(); };
  const pending = f.queue({ images: [input.id] });
  const rejected = assert.rejects(pending, { code: 'INPUT_NOT_FOUND' });
  try { await until(() => reached); await deleteInput(f.store, input.id, f.owner.id); }
  finally { release(); }
  await rejected;
  assert.deepEqual(f.store.jobs(f.owner.id), []);
});

test('HTTP input deletion checks ownership, browser origin, active references and shutdown', async t => {
  const objects = new FakeObjectStore(), f = await fixture(t, objects);
  const input = await f.upload(), { request, url, cookie, server } = await f.serve();
  const foreign = randomUUID(); f.store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(foreign, 'other', 'fixture', new Date().toISOString());
  const foreignCookie = createSession(f.store, { id: foreign, username: 'other' }, false).split(';')[0];
  assert.equal((await fetch(`${url}${input.url}`, { method: 'DELETE' })).status, 401);
  assert.equal((await fetch(`${url}${input.url}`, { method: 'DELETE', headers: { Cookie: cookie } })).status, 403);
  assert.equal((await request(input.url, { method: 'DELETE', headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await request(input.url, { method: 'DELETE', headers: { Cookie: foreignCookie } })).status, 404);
  assert.equal((await request(`/api/inputs/${randomUUID()}`, { method: 'DELETE' })).status, 404);
  assert.deepEqual(objects.deletes, []);
  const job = f.job(input.id);
  const inUse = await request(input.url, { method: 'DELETE' });
  assert.equal(inUse.status, 409); assert.equal((await inUse.json()).error.code, 'INPUT_IN_USE');
  assert.deepEqual(objects.deletes, []);
  f.store.patchJob(job.id, { status: 'cancelled' });
  const removed = await request(input.url, { method: 'DELETE' });
  assert.equal(removed.status, 200); assert.deepEqual(await removed.json(), { deleted: true });
  assert.equal((await request(input.url)).status, 404);
  assert.deepEqual(await (await request('/api/inputs')).json(), { inputs: [] });
  const apiInput = await f.upload(), token = 'fixture-api-token';
  f.store.saveApiToken(f.owner.id, 'test', digest(token));
  assert.equal((await fetch(`${url}${apiInput.url}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status, 200);
  const remaining = await f.upload(); await server.closeOperations();
  assert.equal((await request(remaining.url, { method: 'DELETE' })).status, 503);
  assert.ok(f.store.input(remaining.id, f.owner.id));
});

test('startup resumes remote input deletion without blocking health and shutdown drains it', async t => {
  const objects = new FakeObjectStore(), f = await fixture(t, objects);
  const input = await f.upload(); f.store.beginInputDeletion(input.id, f.owner.id);
  let release!: () => void, reached = false;
  const paused = new Promise<void>(resolve => { release = resolve; });
  objects.beforeDelete = async () => { reached = true; await paused; };
  const { request, server } = await f.serve();
  let drained = false;
  try {
    await until(() => reached);
    assert.equal((await request('/api/health')).status, 200);
    const stopping = server.closeOperations().then(() => { drained = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(drained, false);
    release(); await stopping;
    assert.deepEqual(f.store.inputs(f.owner.id), []); assert.equal(objects.objects.size, 0);
  } finally { release(); }
});
