import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store, publicJob } from '../../apps/server/store.ts';
import { deleteOutput, inputBytes, outputBytes, recoverOutputDeletions, saveInput, saveOutput } from '../../apps/server/media.ts';
import { PNG } from '../inference/fake-comfy.ts';
import { FakeObjectStore } from './helpers/fake-object-store.ts';
import { engineFixture, until } from './helpers/engine-fixture.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }, objectStore: FakeObjectStore | null = new FakeObjectStore()) {
  const directory = await mkdtemp(join(tmpdir(), 'gravity-remote-media-'));
  let store = new Store(directory, { objectStore });
  const owner = store.createOwner('owner', 'fixture-hash');
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory, owner, get store() { return store; },
    restart(next = objectStore) { store.close(); store = new Store(directory, { objectStore: next }); },
    async complete(count = 2) {
      const job = store.createJob(owner.id, { modelId: 'sdxl-base', prompt: 'A saved image', seed: 12 }, {}, [], 'SDXL', {}, randomUUID(), 'fixture');
      store.patchJob(job.id, { status: 'preparing' });
      const outputs = [];
      for (let i = 0; i < count; i++) outputs.push(await saveOutput(store, job.id, i, PNG));
      store.patchJob(job.id, { status: 'succeeded', outputs });
      for (const output of outputs) store.setOutputFavorite(job.id, output.id, owner.id, true);
      return { job, outputs };
    },
  };
}

test('primary object storage saves verified references and outputs without local media or public storage metadata', async t => {
  const objects = new FakeObjectStore(), f = await fixture(t, objects);
  const input = await saveInput(f.store, f.owner.id, Buffer.from(PNG), 'reference.png');
  const { job, outputs } = await f.complete(1);
  const storedInput = f.store.input(input.id, f.owner.id);
  const storedOutput = f.store.output(job.id, outputs[0].id, f.owner.id);
  assert.equal(storedInput.path, undefined); assert.equal(storedOutput.path, undefined);
  assert.deepEqual(objects.puts, [`inputs/${input.id}`, `outputs/${job.id}/${outputs[0].id}`]);
  assert.equal((await readdir(f.directory)).some(name => ['inputs', 'outputs'].includes(name)), false);
  assert.deepEqual(await inputBytes(f.store, input.id, f.owner.id), objects.objects.get(storedInput.object!.key));
  assert.deepEqual(await outputBytes(f.store, job.id, outputs[0].id, f.owner.id), Buffer.from(PNG));
  assert.deepEqual(f.store.inputs(f.owner.id), [input]);
  // Explicit projections remain safe if a caller accidentally embeds a private record.
  const publicValue = publicJob({ ...f.store.job(job.id), outputs: [storedOutput] });
  for (const value of [input, outputs[0], f.store.inputs(f.owner.id)[0], publicValue.outputs[0]]) {
    assert.equal('object' in value, false); assert.equal('path' in value, false); assert.equal('userId' in value, false);
  }
});

test('local media remains readable when S3 becomes primary; migrated media reads only S3 and deletion removes both copies', async t => {
  const f = await fixture(t, null), objects = new FakeObjectStore();
  const input = await saveInput(f.store, f.owner.id, Buffer.from(PNG), 'legacy.png');
  const { job, outputs } = await f.complete(1);
  const localInput = f.store.input(input.id, f.owner.id), localOutput = f.store.output(job.id, outputs[0].id, f.owner.id);
  f.restart(objects);
  assert.deepEqual(await inputBytes(f.store, input.id, f.owner.id), await readFile(localInput.path!));
  assert.deepEqual(await outputBytes(f.store, job.id, localOutput.id, f.owner.id), Buffer.from(PNG));
  assert.equal(objects.gets.length, 0);
  const object = await objects.put(`outputs/${job.id}/${localOutput.id}`, PNG, localOutput.mimeType);
  f.store.saveOutput(job.id, { ...localOutput, object });
  objects.failGet = true;
  await assert.rejects(outputBytes(f.store, job.id, localOutput.id, f.owner.id), { code: 'ASSET_READ_FAILED' });
  assert.deepEqual(await readFile(localOutput.path!), Buffer.from(PNG), 'a surviving local copy must not hide a broken primary store');
  objects.failGet = false;
  await deleteOutput(f.store, job.id, localOutput.id, f.owner.id);
  assert.equal(objects.objects.has(object.key), false);
  await assert.rejects(readFile(localOutput.path!), { code: 'ENOENT' });
  const next = await saveInput(f.store, f.owner.id, Buffer.from(PNG), 'new.png');
  assert.equal(f.store.input(next.id, f.owner.id).path, undefined);
});

test('startup refuses missing or changed object storage identity while allowing the original store', async t => {
  const objects = new FakeObjectStore(), f = await fixture(t, objects);
  await saveInput(f.store, f.owner.id, Buffer.from(PNG), 'reference.png');
  assert.throws(() => new Store(f.directory), { code: 'MEDIA_STORE_CHANGED' });
  assert.throws(() => new Store(f.directory, { objectStore: new FakeObjectStore('different-bucket') }), { code: 'MEDIA_STORE_CHANGED' });
  const same = new Store(f.directory, { objectStore: new FakeObjectStore(objects.id) });
  same.close();
  assert.equal(f.store.inputs(f.owner.id).length, 1);
});

test('failed remote deletion keeps metadata, favorites and retry intent; restart retries idempotently', async t => {
  const objects = new FakeObjectStore(), f = await fixture(t, objects);
  const { job, outputs } = await f.complete();
  const original = f.store.job(job.id), first = f.store.output(job.id, outputs[0].id, f.owner.id);
  objects.failDelete = true;
  await assert.rejects(deleteOutput(f.store, job.id, first.id, f.owner.id), { code: 'OUTPUT_DELETE_FAILED', status: 503 });
  assert.deepEqual(f.store.job(job.id), original);
  assert.equal(f.store.favorites(f.owner.id)[0].outputs.length, 2);
  assert.equal(f.store.pendingOutputDeletions().length, 1);
  assert.throws(() => f.store.saveOutput(job.id, first), { code: 'OUTPUT_DELETION_PENDING' });
  f.restart(); objects.failDelete = false;
  await recoverOutputDeletions(f.store);
  assert.deepEqual(f.store.job(job.id), { ...original, outputs: [original.outputs[1]] });
  assert.equal(objects.objects.has(first.object!.key), false);
  assert.deepEqual(await outputBytes(f.store, job.id, outputs[1].id, f.owner.id), Buffer.from(PNG));
  assert.deepEqual(f.store.pendingOutputDeletions(), []);
  assert.throws(() => f.store.saveOutput(job.id, first), { code: 'JOB_FINISHED' });
  const writes = objects.puts.length;
  await assert.rejects(saveOutput(f.store, job.id, 0, PNG), { code: 'JOB_FINISHED' });
  assert.equal(objects.puts.length, writes, 'late engine work cannot recreate a deleted remote object');
});

test('a database failure after remote deletion leaves an intent that completes after restart', async t => {
  const objects = new FakeObjectStore(), f = await fixture(t, objects);
  const { job, outputs } = await f.complete(1);
  const original = f.store.job(job.id), stored = f.store.output(job.id, outputs[0].id, f.owner.id);
  f.store.db.exec("CREATE TRIGGER fixture_delete_failure BEFORE DELETE ON outputs BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END");
  await assert.rejects(deleteOutput(f.store, job.id, stored.id, f.owner.id), /fixture commit failure/);
  assert.equal(objects.objects.has(stored.object!.key), false);
  assert.deepEqual(f.store.job(job.id), original);
  f.restart(); f.store.db.exec('DROP TRIGGER fixture_delete_failure');
  await recoverOutputDeletions(f.store);
  assert.deepEqual(f.store.job(job.id), { ...original, outputs: [] });
  assert.deepEqual(f.store.pendingOutputDeletions(), []);
  assert.equal(objects.deletes.filter(key => key === stored.object!.key).length, 2);
});

test('an object reference belonging to another image cannot be read or deleted through a tampered record', async t => {
  const objects = new FakeObjectStore(), f = await fixture(t, objects);
  const { job, outputs } = await f.complete();
  const first = f.store.output(job.id, outputs[0].id, f.owner.id), second = f.store.output(job.id, outputs[1].id, f.owner.id);
  f.store.saveOutput(job.id, { ...first, object: second.object });
  await assert.rejects(outputBytes(f.store, job.id, first.id, f.owner.id), { code: 'MEDIA_STORAGE_UNAVAILABLE' });
  await assert.rejects(deleteOutput(f.store, job.id, first.id, f.owner.id), { code: 'OUTPUT_DELETE_FAILED' });
  assert.equal(objects.gets.length, 0); assert.equal(objects.deletes.length, 0);
  assert.equal(objects.objects.size, 2);
});

test('a failed reference metadata commit cleans up its unique remote object', async t => {
  const objects = new FakeObjectStore(), f = await fixture(t, objects);
  f.store.db.exec("CREATE TRIGGER fixture_input_failure BEFORE INSERT ON inputs BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END");
  await assert.rejects(saveInput(f.store, f.owner.id, Buffer.from(PNG), 'reference.png'), /fixture commit failure/);
  assert.equal(objects.objects.size, 0);
  assert.equal(objects.deletes.length, 1);
  assert.deepEqual(f.store.inputs(f.owner.id), []);
});

test('temporary output storage failure recovers ComfyUI history after restart without resubmitting generation', async t => {
  const objects = new FakeObjectStore(); objects.failPut = true;
  const f = await engineFixture({ objectStore: objects }); t.after(f.close);
  const job = await f.queue(); await f.engine.tick();
  await until(() => f.store.job(job.id).status === 'running');
  f.complete(0, job.id);
  await until(() => f.store.job(job.id).status === 'interrupted' && !f.engine.flights.has(job.id));
  assert.deepEqual(f.store.job(job.id).outputs, []);
  assert.equal(f.store.activeJobs().length, 1);
  await f.restart(); objects.failPut = false;
  await f.engine.reconcile();
  await until(() => f.store.job(job.id).status === 'succeeded');
  const output = f.store.job(job.id).outputs[0];
  assert.deepEqual(await outputBytes(f.store, job.id, output.id, f.owner.id), Buffer.from(PNG));
  assert.equal(f.workers[0].state.submissions.length, 1);
  assert.equal(objects.objects.size, 1);
  assert.equal((await readdir(f.directory)).includes('outputs'), false);
});
