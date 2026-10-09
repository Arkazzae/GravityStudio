import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { ApiError } from '../../packages/contracts/index.ts';
import { Store } from '../../apps/server/store.ts';
import type { Engine } from '../../apps/server/engine.ts';
import { LocalTextRuntime, type LocalTextOptions } from '../../apps/server/local-text.ts';
import { LOCAL_TEXT_MODEL } from '../../apps/server/text-models.ts';
import type { TextRuntimeStatus } from '../../scripts/text-runtime.ts';
import runtimeLock from '../../deploy/llamacpp/runtime.lock.json' with { type: 'json' };
import { GiB, inventory } from './helpers/engine-fixture.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(t: TestContext, options: { installed?: boolean; revision?: string; initialize?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'gravity-local-text-'));
  const store = new Store(directory);
  store.setMetadata('local-text-runtime', { revision: 0, gpuIds: ['gpu-0'], ready: true, runtimeRevision: options.revision ?? runtimeLock.revision });
  const hardware = inventory();
  hardware.gpus.forEach((gpu, index) => { gpu.uuid = `GPU-01234567-abcd-${index}`; gpu.memory.totalBytes = 32 * GiB; });
  const state = {
    starts: 0, stops: 0, recoveries: 0, reserves: 0, releases: 0, admissions: 0,
    installedChecks: 0, prepares: 0, downloads: 0, alive: false, running: false,
    containerId: 'container-0', proofs: [] as Array<{ identity: string; bytes: number }>,
    events: [] as string[], failStop: false,
    stopGate: undefined as Promise<void> | undefined,
    admitHook: undefined as (() => Promise<void>) | undefined,
    recoverHook: undefined as (() => Promise<void>) | undefined,
    startHook: undefined as (() => Promise<void>) | undefined,
    statusHook: undefined as (() => Promise<TextRuntimeStatus>) | undefined,
    downloadHook: undefined as (() => Promise<void>) | undefined,
    evict: undefined as (() => Promise<boolean>) | undefined,
  };
  const engine = {
    setTextEviction(evict: () => Promise<boolean>) { state.evict = evict; },
    async hardwareReport() { return structuredClone(hardware); },
    async reserveTextGpu(ids: string[], _memory: unknown, signal: AbortSignal) {
      signal.throwIfAborted();
      assert(ids.length > 0, 'the runtime must select a supported physical GPU');
      assert.equal(state.alive, false, 'a new lease cannot replace an unconfirmed old stop');
      state.reserves++; state.alive = true; state.events.push('reserve');
      let released = false;
      return {
        gpuId: ids[0],
        release() { assert.equal(released, false); released = true; state.alive = false; state.releases++; state.events.push('release'); },
        resident(identity: string, bytes: number) { assert(state.alive); state.proofs.push({ identity, bytes }); },
        async admit() { state.admissions++; await state.admitHook?.(); },
      };
    },
  } as unknown as Engine;
  const files: NonNullable<LocalTextOptions['files']> = {
    path: join(directory, 'model.gguf'),
    async installed() { state.events.push('verify'); state.installedChecks++; return options.installed ?? true; },
    async download(signal, onProgress) { signal.throwIfAborted(); state.downloads++; await state.downloadHook?.(); onProgress({ receivedBytes: 24, totalBytes: 24 }); },
  };
  const container: NonNullable<LocalTextOptions['container']> = {
    async prepare() { state.prepares++; },
    async recover() { state.events.push('recover'); state.recoveries++; await state.recoverHook?.(); state.running = false; },
    async start(_gpu, _hardware, _path, signal) {
      assert(state.alive); state.starts++; state.events.push('start');
      await state.startHook?.(); signal?.throwIfAborted();
      state.running = true; state.containerId = `container-${state.starts}`;
      return { baseUrl: 'http://127.0.0.1:8123/v1', apiKey: 'fixture-runtime-secret', modelId: LOCAL_TEXT_MODEL.id, containerId: state.containerId, allocatedVramBytes: 9 * GiB };
    },
    async status() { return state.statusHook ? state.statusHook() : { running: state.running, containerId: state.containerId, gpuId: 'gpu-0', baseUrl: 'http://127.0.0.1:8123/v1' }; },
    async stop() {
      state.stops++; state.events.push('stop');
      await state.stopGate;
      if (state.failStop) throw new Error('private container diagnostics');
      state.running = false; state.events.push('stopped');
    },
  };
  const runtime = new LocalTextRuntime(store, engine, { files, container });
  t.after(async () => {
    state.failStop = false; state.stopGate = undefined; state.statusHook = undefined;
    await runtime.close(); store.close(); await rm(directory, { recursive: true, force: true });
  });
  if (options.initialize !== false) await runtime.initialize();
  const run = (work: Parameters<LocalTextRuntime['run']>[2] = async () => 'refined', signal = new AbortController().signal) => runtime.run(LOCAL_TEXT_MODEL.id, signal, work);
  return { directory, store, hardware, state, engine, files, container, runtime, run };
}

test('two refinements reuse one warm container and recheck its memory before each request', async t => {
  const f = await fixture(t);
  for (const answer of ['first', 'second']) assert.equal(await f.run(async (connection, model) => {
    assert.equal(connection.apiKey, 'fixture-runtime-secret');
    assert.equal(connection.baseUrl, 'http://127.0.0.1:8123/v1');
    assert.equal(model.id, LOCAL_TEXT_MODEL.id);
    assert.equal(model.inputTokenLimit! + model.outputTokenLimit! + 256, LOCAL_TEXT_MODEL.contextTokens);
    return answer;
  }), answer);
  assert.equal(f.state.starts, 1); assert.equal(f.state.reserves, 1); assert.equal(f.state.stops, 0);
  assert.equal(f.state.admissions, 2); assert.equal(f.state.proofs.length, 2);
  assert.deepEqual(f.state.proofs[0], { identity: 'container-1', bytes: 9 * GiB });
  assert.equal((await f.runtime.status()).phase, 'loaded');
  assert.equal(JSON.stringify(await f.runtime.status()).includes('fixture-runtime-secret'), false);
});

test('active inference cannot be evicted, unloaded, reconfigured or overlapped', async t => {
  const f = await fixture(t), started = deferred(), finish = deferred<string>();
  const pending = f.run(async () => { started.resolve(); return finish.promise; });
  try {
    await started.promise;
    assert.equal(await f.state.evict!(), false);
    await assert.rejects(f.runtime.release(), { code: 'LOCAL_TEXT_BUSY' });
    await assert.rejects(f.runtime.configure({ revision: 0, gpuIds: ['gpu-1'] }), { code: 'LOCAL_TEXT_BUSY' });
    await assert.rejects(f.run(), { code: 'LOCAL_TEXT_BUSY' });
    assert.equal(f.state.stops, 0); assert.equal(f.state.alive, true);
  } finally { finish.resolve('done'); await pending; }
  assert.equal(await f.state.evict!(), true);
  assert.equal(f.state.releases, 1);
});

test('idle eviction retains the GPU lease until the container confirms its stop', async t => {
  const f = await fixture(t); await f.run();
  const stopped = deferred(); f.state.stopGate = stopped.promise;
  const evicting = f.state.evict!();
  try {
    await immediate();
    assert.equal((await f.runtime.status()).phase, 'stopping');
    assert.equal(f.state.alive, true); assert.equal(f.state.releases, 0);
    assert.equal(await f.state.evict!(), false);
    await assert.rejects(f.run(), { code: 'LOCAL_TEXT_BUSY' });
  } finally { stopped.resolve(); }
  assert.equal(await evicting, true);
  assert.equal(f.state.alive, false);
  assert.deepEqual(f.state.events.slice(-3), ['stop', 'stopped', 'release']);
  assert.equal((await f.runtime.status()).phase, 'ready');
});

test('a failed stop holds its lease; the next request must confirm stop before restarting', async t => {
  const f = await fixture(t); await f.run(); f.state.failStop = true;
  await assert.rejects(f.runtime.release(), { code: 'LOCAL_TEXT_STOP_FAILED' });
  const failed = await f.runtime.status();
  assert.equal(failed.phase, 'failed'); assert.equal(failed.gpuId, 'gpu-0'); assert.equal(f.state.releases, 0);
  assert.match(failed.error!, /reservation is retained/); assert.doesNotMatch(failed.error!, /private container/);
  f.state.failStop = false;
  assert.equal(await f.run(async () => 'recovered'), 'recovered');
  assert.equal(f.state.starts, 2); assert.equal(f.state.reserves, 2); assert.equal(f.state.releases, 1);
  assert.equal((await f.runtime.status()).error, null);
  assert.deepEqual(f.state.events.slice(-5), ['stop', 'stopped', 'release', 'reserve', 'start']);
});

test('failed startup also keeps its lease when cleanup cannot confirm stop', async t => {
  const f = await fixture(t); f.state.startHook = async () => { throw new Error('Startup did not complete'); }; f.state.failStop = true;
  await assert.rejects(f.run(), { code: 'LOCAL_TEXT_FAILED' });
  assert.equal(f.state.alive, true); assert.equal(f.state.releases, 0);
  f.state.startHook = undefined; f.state.failStop = false;
  await f.run();
  assert.equal(f.state.reserves, 2); assert.equal(f.state.releases, 1);
});

test('cancelling active inference unloads it and waits for confirmed cleanup', async t => {
  const f = await fixture(t), started = deferred(), stopped = deferred(), controller = new AbortController();
  f.state.stopGate = stopped.promise;
  const pending = f.run(async () => { started.resolve(); return new Promise((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })); }, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  try {
    await started.promise; controller.abort(); await immediate();
    assert.equal(f.state.stops, 1); assert.equal(f.state.releases, 0); assert.equal(f.state.alive, true);
  } finally { controller.abort(); stopped.resolve(); await rejected; }
  assert.equal(f.state.releases, 1); assert.equal((await f.runtime.status()).busy, false);
});

test('cancellation while warm admission is pending prevents invoking the provider', async t => {
  const f = await fixture(t); await f.run();
  const entered = deferred(), finish = deferred(), controller = new AbortController(); let calls = 0;
  f.state.admitHook = async () => { entered.resolve(); await finish.promise; };
  const pending = f.run(async () => { calls++; return 'too late'; }, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  try { await entered.promise; controller.abort(); }
  finally { controller.abort(); finish.resolve(); await rejected; }
  assert.equal(calls, 0); assert.equal(f.state.releases, 1);
});

test('warm admission failure avoids inference and unloads the now-ineligible resident model', async t => {
  const f = await fixture(t); await f.run(); let calls = 0;
  f.state.admitHook = async () => { throw new ApiError(409, 'TEXT_GPU_BUSY', 'Other work needs the remaining memory'); };
  await assert.rejects(f.run(async () => { calls++; }), { code: 'TEXT_GPU_BUSY' });
  assert.equal(calls, 0); assert.equal(f.state.releases, 1); assert.equal(f.state.stops, 1);
});

test('initialization recovers an orphan before verifying files or advertising the local model', async t => {
  const f = await fixture(t, { initialize: false });
  const recovery = deferred(); f.state.recoverHook = () => recovery.promise;
  const initializing = f.runtime.initialize();
  try { assert.equal(f.state.installedChecks, 0); assert.deepEqual((await f.runtime.models()).models, []); }
  finally { recovery.resolve(); await initializing; }
  assert.deepEqual(f.state.events, ['recover', 'verify']);
  assert.equal((await f.runtime.models()).models[0].id, LOCAL_TEXT_MODEL.id);
  await f.run(); await f.runtime.close();
  const restarted = new LocalTextRuntime(f.store, f.engine, { files: f.files, container: f.container });
  await restarted.initialize();
  assert.equal(f.state.recoveries, 2); assert.equal((await restarted.status()).phase, 'ready');
  assert.deepEqual((await restarted.status()).gpuIds, ['gpu-0']);
  await restarted.close();
});

test('failed orphan recovery prevents model readiness and file verification', async t => {
  const f = await fixture(t, { initialize: false });
  f.state.recoverHook = async () => { throw new Error('Cannot confirm orphan stopped'); };
  await assert.rejects(f.runtime.initialize(), /Cannot confirm orphan stopped/);
  assert.equal(f.state.installedChecks, 0); assert.deepEqual((await f.runtime.models()).models, []);
});

test('missing files and a changed runtime pin invalidate persisted readiness', async t => {
  for (const options of [{ installed: false }, { revision: 'previous-runtime-revision' }]) await t.test(JSON.stringify(options), async t => {
    const f = await fixture(t, options);
    assert.equal((await f.runtime.status()).ready, false);
    assert.deepEqual((await f.runtime.models()).models, []);
    await assert.rejects(f.run(), { code: 'LOCAL_TEXT_NOT_READY' });
    assert.equal(f.state.reserves, 0);
  });
});

test('preparation invalidates persisted readiness until every setup step succeeds', async t => {
  const f = await fixture(t), download = deferred(); f.state.downloadHook = () => download.promise;
  try {
    await f.runtime.prepare({ modelId: LOCAL_TEXT_MODEL.id });
    assert.equal((await f.runtime.status()).ready, false);
    assert.equal(f.store.metadata<{ ready: boolean }>('local-text-runtime')!.ready, false);
  } finally { download.reject(new Error('Download interrupted')); await immediate(); }
  assert.equal((await f.runtime.status()).phase, 'failed');
  assert.equal(f.store.metadata<{ ready: boolean }>('local-text-runtime')!.ready, false);
  f.state.downloadHook = undefined;
  await f.runtime.prepare({ modelId: LOCAL_TEXT_MODEL.id }); await immediate();
  assert.equal((await f.runtime.status()).ready, true);
  assert.equal(f.store.metadata<{ runtimeRevision: string }>('local-text-runtime')!.runtimeRevision, runtimeLock.revision);
});

test('maintenance refreshes owned allocations during active inference and does not evict it', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const settings = f.store.settings(); settings.policy.idleUnloadSeconds = 1; f.store.saveSettings(settings);
  const started = deferred(), finish = deferred();
  const pending = f.run(async () => { started.resolve(); await finish.promise; });
  try {
    await started.promise;
    for (let index = 0; index < 4; index++) { t.mock.timers.tick(5000); await immediate(); }
    assert.equal(f.state.proofs.length, 5); assert.equal(f.state.stops, 0); assert.equal(f.state.alive, true);
  } finally { finish.resolve(); await pending; }
  t.mock.timers.tick(5000); await immediate();
  assert.equal(f.state.stops, 1); assert.equal(f.state.releases, 1);
});

test('a delayed maintenance status cannot unload a request that started after the check', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.run();
  const stale = deferred<TextRuntimeStatus>(); let checked = false;
  f.state.statusHook = async () => { checked = true; return stale.promise; };
  const started = deferred(), finish = deferred();
  let pending: Promise<unknown> | undefined;
  try {
    t.mock.timers.tick(5000); assert.equal(checked, true);
    f.state.statusHook = undefined;
    pending = f.run(async () => { started.resolve(); await finish.promise; }); await started.promise;
    stale.resolve({ running: false, containerId: null, gpuId: null, baseUrl: null }); await immediate();
    assert.equal(f.state.stops, 0); assert.equal(f.state.alive, true);
  } finally {
    stale.resolve({ running: true, containerId: f.state.containerId, gpuId: 'gpu-0', baseUrl: null });
    finish.resolve(); await pending;
  }
});

test('a changed GPU policy unloads warm weights before selecting another allowed device', async t => {
  const f = await fixture(t); await f.run();
  // Global worker settings may change separately from local-assistant settings.
  f.store.setMetadata('local-text-runtime', { revision: 1, gpuIds: ['gpu-1'], ready: true, runtimeRevision: runtimeLock.revision });
  await f.run();
  assert.equal(f.state.starts, 2); assert.equal(f.state.releases, 1);
  assert.equal((await f.runtime.status()).gpuId, 'gpu-1');
});
