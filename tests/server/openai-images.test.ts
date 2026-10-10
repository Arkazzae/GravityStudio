import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { ApiMedia, hash } from '../../apps/server/api-media.ts';
import { imageBody, ImageRequestError, openaiImages } from '../../apps/server/openai-images.ts';
import { deleteInput, inputBytes, saveInput, saveOutput } from '../../apps/server/media.ts';
import { ApiError } from '../../packages/contracts/index.ts';
import { engineFixture } from './helpers/engine-fixture.ts';
import { PNG } from '../inference/fake-comfy.ts';
import { publicJob } from '../../apps/server/store.ts';

const sharp = createRequire(new URL('../../apps/server/package.json', import.meta.url))('sharp') as typeof import('../../apps/server/node_modules/sharp/lib/index.d.ts');

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const f = await engineFixture();
  t.after(async () => { f.engine.ticking = false; await f.close(); });
  const media = new ApiMedia(f.store);
  f.engine.ticking = true; // Keep durable submissions queued unless this fixture explicitly finishes them.
  const submit = f.engine.submit.bind(f.engine);
  let outcome: 'queued' | 'succeeded' | 'failed' | 'interrupted' = 'succeeded';
  f.engine.submit = async (owner, input, key) => {
    const job = await submit(owner, input, key);
    if (job.status !== 'queued' || outcome === 'queued') return job;
    f.store.patchJob(job.id, { status: 'preparing' });
    if (outcome === 'failed' || outcome === 'interrupted') return publicJob(f.store.patchJob(job.id, { status: outcome }));
    f.store.patchJob(job.id, { status: 'running' });
    const output = await saveOutput(f.store, job.id, 0, PNG);
    return publicJob(f.store.patchJob(job.id, { status: 'succeeded', outputs: [f.store.output(job.id, output.id, owner)] }));
  };
  const request = (body: Record<string, unknown>, options: Partial<Parameters<typeof openaiImages>[0]> = {}) => openaiImages({
    engine: f.engine, store: f.store, media, userId: f.owner.id, body, editing: false, key: 'fixture-image-request', signal: new AbortController().signal,
    origin: 'https://studio.example', waitMs: 10, authorize: () => {}, ...options,
  });
  return { ...f, media, request, outcome: (value: typeof outcome) => { outcome = value; } };
}
const basic = { model: 'sdxl-base', prompt: 'A ceramic cup', size: '1024x1024', studio: { seed: 42 } };
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

test('OpenAI image batches return base64, stable job IDs and recover unchanged requests', async t => {
  const f = await fixture(t);
  const body = { ...basic, n: 2 };
  const first = await f.request(body);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('Idempotency-Key'), 'fixture-image-request');
  const payload = await first.json();
  assert.equal(payload.data.length, 2);
  assert.deepEqual(Buffer.from(payload.data[0].b64_json, 'base64'), Buffer.from(PNG));
  const ids = first.headers.get('X-Gravity-Job-Ids')!.split(',');
  assert.equal(ids.length, 2);
  assert.equal(first.headers.get('Location'), `/api/jobs/${ids[0]}`);
  assert.deepEqual(ids.map(id => f.store.job(id).input).map(input => 'seed' in input ? input.seed : undefined), [42, 43]);
  const recovered = await f.request(body);
  assert.deepEqual(await recovered.json(), payload);
  assert.equal(recovered.headers.get('X-Gravity-Job-Ids'), ids.join(','));
  assert.equal(f.store.jobs(f.owner.id).length, 2);
  await assert.rejects(f.request({ ...body, prompt: 'Different image' }), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(f.store.jobs(f.owner.id).length, 2);
});

test('OpenAI accepted jobs survive pending responses and explicit async polling', async t => {
  const f = await fixture(t); f.outcome('queued');
  const accepted = await f.request(basic, { asynchronous: true });
  const payload = await accepted.json();
  assert.equal(accepted.status, 202);
  assert.equal(payload.jobs.length, 1);
  assert.equal(payload.jobs[0].status, 'queued');
  assert.deepEqual(payload.data, []);
  const id = payload.jobs[0].id;
  await assert.rejects(f.request(basic), error => error instanceof ImageRequestError && error.code === 'IMAGE_JOB_PENDING' && error.jobIds[0] === id);
  assert.equal(f.store.jobs(f.owner.id).length, 1);
  assert.equal(f.store.job(id).status, 'queued');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.request(basic, { signal: controller.signal }));
  assert.equal(f.store.job(id).status, 'queued', 'Disconnecting does not cancel durable work');
});

test('OpenAI failed and interrupted jobs report durable IDs without silently resubmitting', async t => {
  const f = await fixture(t);
  for (const outcome of ['failed', 'interrupted'] as const) {
    f.outcome(outcome);
    await assert.rejects(f.request(basic, { key: `failure-${outcome}` }), error => error instanceof ImageRequestError && error.code === 'IMAGE_JOB_FAILED' && error.jobIds.length === 1 && f.store.job(error.jobIds[0]).status === outcome);
  }
  assert.equal(f.store.jobs(f.owner.id).length, 2);
  await assert.rejects(f.request(basic, { key: 'failure-failed' }), code('IMAGE_JOB_FAILED'));
  assert.equal(f.store.jobs(f.owner.id).length, 2);
});

test('OpenAI completed batch replay remains readable if its model is subsequently disabled', async t => {
  const f = await fixture(t);
  const response = await f.request(basic);
  const expected = await response.json();
  const settings = f.store.settings();
  settings.modelConfigurations.find(model => model.modelId === 'sdxl-base')!.enabled = false;
  f.store.saveSettings(settings);
  const replay = await f.request(basic);
  assert.equal(replay.headers.get('X-Gravity-Job-Ids'), response.headers.get('X-Gravity-Job-Ids'));
  assert.deepEqual(await replay.json(), expected);
  assert.equal(f.store.jobs(f.owner.id).length, 1);
});

test('OpenAI JSON edits reuse owned file IDs and reject another account or remote URL', async t => {
  const f = await fixture(t);
  const input = await saveInput(f.store, f.owner.id, Buffer.from(PNG), 'reference.png');
  const body = { ...basic, images: [{ file_id: input.id }] };
  const result = await f.request(body, { editing: true });
  assert.equal(result.status, 200);
  const job = f.store.jobs(f.owner.id)[0];
  assert.equal(job.input.operation, 'image-to-image');
  assert.deepEqual('images' in job.input && job.input.images, [input.id]);
  assert.equal(f.store.inputs(f.owner.id).length, 1);
  await assert.rejects(f.media.image(randomUUID(), { file_id: input.id }, 'foreign-image'), code('INPUT_NOT_FOUND'));
  await assert.rejects(f.request({ ...body, images: [{ image_url: 'https://attacker.example/image.png' }] }, { editing: true, key: 'remote-image' }), code('INVALID_IMAGE'));
  assert.equal(f.store.jobs(f.owner.id).length, 1);
  assert.equal(f.store.inputs(f.owner.id).length, 1);
});

test('OpenAI completed edit replay remains readable after deleting its original reference', async t => {
  const f = await fixture(t);
  const input = await saveInput(f.store, f.owner.id, Buffer.from(PNG), 'reference.png');
  const body = { ...basic, images: [{ file_id: input.id }] };
  const original = await f.request(body, { editing: true });
  const expected = await original.json();
  await deleteInput(f.store, input.id, f.owner.id);
  const replay = await f.request(body, { editing: true });
  assert.deepEqual(await replay.json(), expected);
  assert.equal(replay.headers.get('X-Gravity-Job-Ids'), original.headers.get('X-Gravity-Job-Ids'));
  assert.equal(f.store.jobs(f.owner.id).length, 1);
  assert.equal(f.store.inputs(f.owner.id).length, 0, 'Recovery reads the accepted output without recreating a deleted source');
});

test('OpenAI multipart edits parse image files and reuse identical uploads on request replay', async t => {
  const f = await fixture(t);
  const form = new FormData();
  form.set('model', 'sdxl-base'); form.set('prompt', 'A brighter image'); form.set('n', '1'); form.set('studio', '{"steps":4}');
  form.append('image[]', new File([PNG], 'reference.png', { type: 'image/png' }));
  const encoded = new Request('http://localhost/images/edits', { method: 'POST', body: form });
  const body = await imageBody(Buffer.from(await encoded.arrayBuffer()), encoded.headers.get('Content-Type')!);
  assert.equal(body.n, 1);
  assert.ok(Array.isArray(body.images) && body.images[0] instanceof File);
  const first = await f.request(body, { editing: true });
  const second = await f.request(body, { editing: true });
  assert.equal(first.headers.get('X-Gravity-Job-Ids'), second.headers.get('X-Gravity-Job-Ids'));
  assert.equal(f.store.inputs(f.owner.id).length, 1);
  assert.equal(f.store.jobs(f.owner.id).length, 1);
  await assert.rejects(imageBody(Buffer.from('{invalid'), 'application/json'), code('INVALID_IMAGE_REQUEST'));
  const duplicates = new FormData(); duplicates.append('prompt', 'One'); duplicates.append('prompt', 'Two');
  const duplicateRequest = new Request('http://localhost', { method: 'POST', body: duplicates });
  await assert.rejects(imageBody(Buffer.from(await duplicateRequest.arrayBuffer()), duplicateRequest.headers.get('Content-Type')!), code('INVALID_IMAGE_REQUEST'));
});

test('OpenAI alpha masks convert transparent pixels to the Studio white-edit convention', async t => {
  const f = await fixture(t);
  const source = await saveInput(f.store, f.owner.id, await sharp({ create: { width: 2, height: 1, channels: 3, background: '#334455' } }).png().toBuffer(), 'source.png');
  const rgba = await sharp(Buffer.from([100, 110, 120, 0, 100, 110, 120, 255]), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  const mask = await f.media.openaiMask(f.owner.id, new File([new Uint8Array(rgba)], 'mask.png', { type: 'image/png' }), source, 'converted-mask');
  const pixels = await sharp(await inputBytes(f.store, mask.id, f.owner.id)).removeAlpha().raw().toBuffer();
  assert.deepEqual([...pixels], [255, 255, 255, 0, 0, 0]);
  const again = await f.media.openaiMask(f.owner.id, new File([new Uint8Array(rgba)], 'mask.png', { type: 'image/png' }), source, 'converted-mask');
  assert.equal(again.id, mask.id);
  const before = f.store.inputs(f.owner.id).length;
  await assert.rejects(f.media.openaiMask(f.owner.id, { file_id: source.id }, source, 'no-alpha-mask'), code('INVALID_MASK'));
  assert.equal(f.store.inputs(f.owner.id).length, before);
});

test('OpenAI rejects unsupported parameters before importing files or creating jobs', async t => {
  const f = await fixture(t);
  const image = new File([PNG], 'reference.png', { type: 'image/png' });
  for (const patch of [{ mystery: true }, { studio: { unsupported: true } }, { studio: { steps: '4' } }, { studio: { cfg: -1 } }, { studio: { matchSource: 1 } }, { studio: { operation: ['reference'] } }, { stream: true }, { n: 11 }, { size: 'invalid' }, { output_compression: 80 }, { background: 'transparent', output_format: 'jpeg' }, { background: 'transparent', output_format: ['jpeg'] }, { quality: ['high'] }, { background: ['opaque'] }, { response_format: ['url'] }]) {
    await assert.rejects(f.request({ ...basic, images: [image], ...patch }, { editing: true }), code('INVALID_IMAGE_REQUEST'));
    assert.equal(f.store.inputs(f.owner.id).length, 0);
    assert.equal(f.store.jobs(f.owner.id).length, 0);
  }
});

test('OpenAI private download tickets expire and reject disabled accounts', async t => {
  const f = await fixture(t);
  const response = await f.request({ ...basic, response_format: 'url', output_format: 'webp', output_compression: 80 });
  const payload = await response.json();
  const url = new URL(payload.data[0].url);
  assert.equal(url.origin, 'https://studio.example');
  const secret = url.pathname.split('/').at(-1)!;
  const stored = f.store.db.prepare('SELECT hash,user_id FROM api_downloads').get()!;
  assert.equal(stored.hash, hash(secret)); assert.equal(stored.user_id, f.owner.id);
  const download = await new ApiMedia(f.store).download(secret);
  assert.equal(download.mimeType, 'image/webp');
  assert.equal((await sharp(download.bytes).metadata()).format, 'webp');
  await assert.rejects(f.media.download('bad-token'), code('DOWNLOAD_EXPIRED'));
  const job = f.store.jobs(f.owner.id)[0];
  assert.throws(() => f.media.ticket(randomUUID(), job.id, job.outputs[0].id, 'png'), error => error instanceof ApiError);
  f.store.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(f.owner.id);
  await assert.rejects(f.media.download(secret), code('ACCOUNT_INACTIVE'));
  f.store.db.prepare("UPDATE users SET status='active' WHERE id=?").run(f.owner.id);
  f.store.db.prepare('UPDATE api_downloads SET expires_at=? WHERE hash=?').run(Date.now() - 1, hash(secret));
  await assert.rejects(f.media.download(secret), code('DOWNLOAD_EXPIRED'));
});

test('MCP inline upload idempotency survives service recreation and concurrent conflicts', async t => {
  const f = await fixture(t);
  const body = { name: 'reference.png', mimeType: 'image/png', data: Buffer.from(PNG).toString('base64'), idempotencyKey: 'reusable-mcp-upload' };
  const [first, second] = await Promise.all([f.media.inline(f.owner.id, body), f.media.inline(f.owner.id, body)]);
  assert.equal(first.id, second.id);
  assert.equal((await new ApiMedia(f.store).inline(f.owner.id, body)).id, first.id);
  const concurrent = await Promise.allSettled([
    f.media.inline(f.owner.id, { ...body, idempotencyKey: 'concurrent-conflict', name: 'one.png' }),
    f.media.inline(f.owner.id, { ...body, idempotencyKey: 'concurrent-conflict', name: 'two.png' }),
  ]);
  assert.equal(concurrent[0].status, 'fulfilled'); assert.equal(concurrent[1].status, 'rejected');
  assert.ok(concurrent[1].status === 'rejected' && code('IDEMPOTENCY_CONFLICT')(concurrent[1].reason));
  assert.equal(f.store.inputs(f.owner.id).length, 2);
  await deleteInput(f.store, first.id, f.owner.id);
  await assert.rejects(f.media.inline(f.owner.id, body), code('REFERENCE_DELETED'));
  assert.equal(f.store.inputs(f.owner.id).length, 1, 'Recovery never reimports a deliberately deleted asset');
});
