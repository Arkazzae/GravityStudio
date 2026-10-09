import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as immediate } from 'node:timers/promises';
import { engineFixture, GiB, until } from './helpers/engine-fixture.ts';

const memory = { ramBytes: 12 * GiB, vramBytes: 12 * GiB };
const signal = () => new AbortController().signal;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

test('resident text weights and an image job share one GPU when their combined budgets fit', async t => {
  const f = await engineFixture({ location: 'local' }); t.after(f.close);
  f.hardware.gpus[0].memory.totalBytes = 24 * GiB;
  const resident = await f.engine.reserveTextGpu(['gpu-0'], memory, signal());
  f.hardware.gpus[0].memory.usedBytes = 9 * GiB;
  resident.resident('owned-llama-container', 9 * GiB);
  let evictions = 0; f.engine.setTextEviction(async () => { evictions++; return false; });
  const job = await f.queue(); await f.engine.tick();
  await until(() => f.store.job(job.id).status === 'running');
  assert.equal(f.store.job(job.id).workerId, 'worker-0');
  assert.equal(evictions, 0); assert.equal(f.workers[0].state.frees, 0);
  await resident.admit();
  assert.equal(f.workers[0].state.submissions.length, 1);
  resident.release();
});

test('text can join an active image GPU without releasing its image model', async t => {
  const f = await engineFixture({ location: 'local' }); t.after(f.close);
  f.hardware.gpus[0].memory.totalBytes = 32 * GiB;
  const job = await f.queue(); await f.engine.tick();
  await until(() => f.store.job(job.id).status === 'running');
  f.hardware.gpus[0].memory.usedBytes = 6 * GiB;
  const text = await f.engine.reserveTextGpu(['gpu-0'], memory, signal());
  assert.equal(text.gpuId, 'gpu-0'); assert.equal(f.workers[0].state.frees, 0);
  assert.equal(f.store.job(job.id).status, 'running');
  text.release();
});

test('image pressure waits for confirmed text eviction and then measures the released GPU', async t => {
  const f = await engineFixture({ location: 'local' }); t.after(f.close);
  const text = await f.engine.reserveTextGpu(['gpu-0'], memory, signal());
  f.hardware.gpus[0].memory.usedBytes = 9 * GiB; text.resident('owned-container', 9 * GiB);
  const stopping = deferred(), stopped = deferred(); let evictions = 0;
  f.engine.setTextEviction(async () => {
    evictions++; stopping.resolve(); await stopped.promise;
    f.hardware.gpus[0].memory.usedBytes = 0;
    text.release(); return true;
  });
  const job = await f.queue(), ticking = f.engine.tick();
  try {
    await stopping.promise;
    assert.equal(f.store.job(job.id).status, 'queued'); assert.equal(f.workers[0].state.submissions.length, 0);
    await assert.rejects(f.engine.reserveTextGpu(['gpu-0'], memory, signal()), { code: 'TEXT_GPU_BUSY' });
  } finally { stopped.resolve(); await ticking; }
  assert.equal(f.store.job(job.id).status, 'queued', 'a lease change invalidates the in-flight admission decision');
  await f.engine.tick(); await until(() => f.store.job(job.id).status === 'running');
  assert.equal(evictions, 1); assert.equal(f.workers[0].state.frees, 0);
});

test('failed text eviction leaves image work queued and preserves its memory reservation', async t => {
  const f = await engineFixture({ location: 'local' }); t.after(f.close);
  const text = await f.engine.reserveTextGpu(['gpu-0'], memory, signal());
  f.hardware.gpus[0].memory.usedBytes = 9 * GiB; text.resident('owned-container', 9 * GiB);
  f.engine.setTextEviction(async () => { throw new Error('Owned container is still running'); });
  const job = await f.queue(); await f.engine.tick();
  assert.equal(f.store.job(job.id).status, 'queued'); assert.equal(f.workers[0].state.submissions.length, 0);
  assert.equal(f.workers[0].state.frees, 0);
  await assert.rejects(f.engine.reserveTextGpu(['gpu-0'], memory, signal()), { code: 'TEXT_GPU_BUSY' });
  f.engine.setTextEviction(async () => { f.hardware.gpus[0].memory.usedBytes = 0; text.release(); return true; });
  await f.engine.tick(); await f.engine.tick();
  await until(() => f.store.job(job.id).status === 'running');
});

test('an image awaiting GPU telemetry cannot overtake a newly retained text lease', async t => {
  const f = await engineFixture({ location: 'local' }); t.after(f.close);
  const job = await f.queue(), entered = deferred(), measured = deferred();
  let first = true;
  f.beforeDetect = async () => { if (first) { first = false; entered.resolve(); await measured.promise; } };
  const ticking = f.engine.tick(); await entered.promise;
  let text: Awaited<ReturnType<typeof f.engine.reserveTextGpu>>;
  try {
    text = await f.engine.reserveTextGpu(['gpu-0'], memory, signal());
    f.engine.setTextEviction(async () => false);
  } finally { measured.resolve(); await ticking; }
  assert.equal(f.store.job(job.id).status, 'queued'); assert.equal(f.workers[0].state.submissions.length, 0);
  assert.equal(f.workers[0].state.frees, 0, 'the revision guard defers reclamation as well as dispatch');
  text.release();
  await until(() => !f.engine.ticking);
});

test('RAM reservations are shared across GPUs and released independently', async t => {
  const f = await engineFixture({ count: 0 }); t.after(f.close);
  f.hardware.host.memory = { totalBytes: 24 * GiB, availableBytes: 24 * GiB };
  const first = await f.engine.reserveTextGpu(['gpu-0'], memory, signal());
  await assert.rejects(f.engine.reserveTextGpu(['gpu-1'], memory, signal()), { code: 'TEXT_GPU_BUSY', message: /RAM/ });
  assert.throws(() => f.engine.beginRuntimeSetup(), { code: 'TEXT_GPU_BUSY' });
  first.release();
  const second = await f.engine.reserveTextGpu(['gpu-1'], memory, signal());
  assert.equal(second.gpuId, 'gpu-1'); second.release();
  f.engine.beginRuntimeSetup(); f.engine.endRuntimeSetup();
});

test('GPU capacity is never pooled and unavailable or fully occupied GPUs cannot be reserved', async t => {
  const f = await engineFixture({ count: 0 }); t.after(f.close);
  f.hardware.gpus.forEach(gpu => { gpu.memory.totalBytes = 16 * GiB; });
  await assert.rejects(f.engine.reserveTextGpu(['gpu-0', 'gpu-1'], { ...memory, vramBytes: 20 * GiB }, signal()), { code: 'TEXT_GPU_BUSY', message: /do not fit/ });
  f.hardware.gpus[0].memory.usedBytes = null;
  f.hardware.gpus[1].memory.usedBytes = 15 * GiB;
  await assert.rejects(f.engine.reserveTextGpu(['gpu-0', 'gpu-1'], memory, signal()), { code: 'TEXT_GPU_BUSY' });
  f.hardware.gpus[1].memory.usedBytes = 0;
  const available = await f.engine.reserveTextGpu(['gpu-0', 'gpu-1'], memory, signal());
  assert.equal(available.gpuId, 'gpu-1'); available.release();
});

test('resident allocation credits expire and never include unreported RAM usage', async t => {
  const f = await engineFixture({ count: 0 }); t.after(f.close);
  f.hardware.gpus[0].memory.totalBytes = 24 * GiB;
  const text = await f.engine.reserveTextGpu(['gpu-0'], memory, signal());
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  f.hardware.gpus[0].memory.usedBytes = 14 * GiB;
  text.resident('owned-container', 9 * GiB); await text.admit();
  t.mock.timers.tick(15_001);
  await assert.rejects(text.admit(), { code: 'TEXT_GPU_BUSY', message: /GPU/ });
  text.resident('owned-container', 9 * GiB); await text.admit();
  f.hardware.host.memory.availableBytes = 12 * GiB;
  await assert.rejects(text.admit(), { code: 'TEXT_GPU_BUSY', message: /RAM/ });
  f.hardware.host.memory.availableBytes = 64 * GiB;
  text.resident('owned-container', 0);
  await assert.rejects(text.admit(), { code: 'TEXT_GPU_BUSY' });
  text.release();
  await assert.rejects(text.admit(), { code: 'TEXT_GPU_BUSY' });
});

test('unrelated GPU allocations are not credited as text model weights', async t => {
  const f = await engineFixture({ location: 'local' }); t.after(f.close);
  f.hardware.gpus[0].memory.totalBytes = 24 * GiB;
  const text = await f.engine.reserveTextGpu(['gpu-0'], memory, signal());
  f.hardware.gpus[0].memory.usedBytes = 17 * GiB;
  text.resident('owned-container', 9 * GiB);
  f.engine.setTextEviction(async () => false);
  const job = await f.queue(); await f.engine.tick();
  assert.equal(f.store.job(job.id).status, 'queued'); assert.equal(f.workers[0].state.submissions.length, 0);
  text.release(); await immediate();
});

test('cancellation during fresh measurements rolls back only the tentative text reservation', async t => {
  const f = await engineFixture({ count: 0 }); t.after(f.close);
  const measured = deferred(), entered = deferred(), controller = new AbortController(); let reads = 0;
  f.beforeDetect = async () => { if (++reads === 2) { entered.resolve(); await measured.promise; } };
  const pending = f.engine.reserveTextGpu(['gpu-0'], memory, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  try {
    await entered.promise;
    await assert.rejects(f.engine.reserveTextGpu(['gpu-0'], memory, signal()), { code: 'TEXT_GPU_BUSY' });
  } finally { controller.abort(); measured.resolve(); await rejected; }
  const next = await f.engine.reserveTextGpu(['gpu-0'], memory, signal());
  next.release();
  f.engine.beginRuntimeSetup(); f.engine.endRuntimeSetup();
});

test('an active image with an unidentified local device prevents every text placement', async t => {
  const f = await engineFixture({ location: 'local' }); t.after(f.close);
  const settings = f.store.settings(); settings.workers[0].deviceIds = []; f.store.saveSettings(settings);
  const job = await f.queue();
  // A recovered legacy image reservation may predate physical-device selection.
  f.store.patchJob(job.id, { status: 'preparing', workerId: 'worker-0' });
  await assert.rejects(f.engine.reserveTextGpu(['gpu-0', 'gpu-1'], memory, signal()), { code: 'TEXT_GPU_BUSY' });
  assert.equal(f.workers[0].state.frees, 0);
});
