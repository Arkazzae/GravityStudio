import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, type GenerationInput } from '../../packages/contracts/index.ts';
import { ApiMedia, canonical, hash } from './api-media.ts';
import type { Engine } from './engine.ts';
import { publicJob, type Store } from './store.ts';

export const OPENAI_IMAGE_BODY_LIMIT = 64 * 1024 ** 2;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function invalid(message: string): never { throw new ApiError(400, 'INVALID_IMAGE_REQUEST', message); }
export class ImageRequestError extends ApiError {
  jobIds: string[];
  constructor(status: number, code: string, message: string, jobs: string[]) { super(status, code, message); this.jobIds = jobs; }
}
export async function imageBody(bytes: Buffer, contentType: string): Promise<Record<string, unknown>> {
  if (contentType.startsWith('application/json')) {
    try { const body: unknown = JSON.parse(bytes.toString('utf8')); if (object(body)) return body; } catch { /* Return the public validation error. */ }
    invalid('Supply a JSON object for this image request.');
  }
  if (!contentType.startsWith('multipart/form-data;')) invalid('Use application/json or multipart/form-data.');
  let form: FormData;
  try { form = await new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': contentType }, body: new Uint8Array(bytes) }).formData(); }
  catch { invalid('The multipart image request could not be read.'); }
  const body: Record<string, unknown> = {}, images: File[] = [];
  const entries: Array<[string, FormDataEntryValue]> = [];
  form.forEach((value, name) => entries.push([name, value]));
  for (const [name, value] of entries) {
    if (name === 'image' || name === 'image[]') {
      if (!(value instanceof File)) invalid('Attach image files using image or image[].');
      images.push(value); continue;
    }
    if (Object.hasOwn(body, name)) invalid(`Supply ${name} only once.`);
    if (name === 'mask' || name === 'file') { if (!(value instanceof File)) invalid(`Attach ${name} as a file.`); body[name] = value; continue; }
    if (typeof value !== 'string') invalid(`Supply ${name} as text.`);
    if (['n', 'output_compression', 'partial_images'].includes(name)) body[name] = Number(value);
    else if (['stream', 'studio'].includes(name)) { try { body[name] = JSON.parse(value); } catch { invalid(`Supply valid JSON for ${name}.`); } }
    else body[name] = value;
  }
  if (images.length) { if (Object.hasOwn(body, 'images')) invalid('Use a single image list.'); body.images = images; }
  return body;
}

export async function openaiImages(options: {
  engine: Engine; store: Store; media: ApiMedia; userId: string; body: Record<string, unknown>; editing: boolean;
  key?: string; signal: AbortSignal; origin: string; asynchronous?: boolean; waitMs?: number; authorize: () => void;
}): Promise<Response> {
  const { engine, store, media, userId, body, signal, editing } = options;
  const fields = ['model', 'prompt', 'n', 'size', 'quality', 'background', 'response_format', 'output_format', 'output_compression', 'user', 'studio', 'stream', ...(editing ? ['images', 'mask'] : [])];
  const unknown = Object.keys(body).find(key => !fields.includes(key));
  if (unknown) invalid(`Unsupported image parameter: ${unknown}. Use studio for supported Studio generation options.`);
  if (typeof body.model !== 'string' || !body.model || body.model.length > 96) invalid('Choose an image model ID from /v1/models.');
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 16_000) invalid('Supply a prompt containing 1–16,000 characters.');
  if (body.stream !== undefined && body.stream !== false) invalid('Image streaming is not supported. Use the durable job API for progress; chat supports streaming.');
  if (body.user !== undefined && (typeof body.user !== 'string' || body.user.length > 256)) invalid('user must be a string of at most 256 characters.');
  const n = body.n ?? 1;
  if (!Number.isSafeInteger(n) || Number(n) < 1 || Number(n) > 10) invalid('n must be between 1 and 10.');
  const responseFormat = body.response_format ?? 'b64_json', outputFormat = body.output_format ?? 'png';
  if (typeof responseFormat !== 'string' || !['url', 'b64_json'].includes(responseFormat) || typeof outputFormat !== 'string' || !['png', 'jpeg', 'webp'].includes(outputFormat)) invalid('Choose b64_json or url, with png, jpeg or webp output.');
  const compression = body.output_compression;
  if (compression !== undefined && (!Number.isInteger(compression) || Number(compression) < 0 || Number(compression) > 100 || outputFormat === 'png')) invalid('output_compression must be 0–100 and applies to JPEG or WebP.');
  if (body.background !== undefined && (typeof body.background !== 'string' || !['auto', 'opaque', 'transparent'].includes(body.background))) invalid('Choose auto, opaque or transparent background.');
  if (outputFormat === 'jpeg' && body.background === 'transparent') invalid('Choose PNG or WebP to preserve transparency.');
  const qualities: Record<string, GenerationInput['quality']> = { low: 'fast', medium: 'standard', high: 'high', hd: 'high', fast: 'fast', standard: 'standard', ultra: 'ultra' };
  if (body.quality !== undefined && (typeof body.quality !== 'string' || body.quality !== 'auto' && !Object.hasOwn(qualities, body.quality))) invalid('Choose auto, low, medium, high or Studio fast, standard, ultra quality.');
  const studio = body.studio ?? {};
  if (!object(studio) || Object.keys(studio).some(key => !['operation', 'negativePrompt', 'steps', 'cfg', 'seed', 'sampler', 'scheduler', 'denoise', 'outpaint', 'matchSource', 'refiner', 'referenceStrength', 'loras'].includes(key))) invalid('studio contains unsupported generation options.');
  for (const field of ['negativePrompt', 'sampler', 'scheduler'] as const) {
    if (studio[field] !== undefined && (typeof studio[field] !== 'string' || (studio[field] as string).length > (field === 'negativePrompt' ? 16_000 : 100))) invalid(`studio.${field} must be a valid string.`);
  }
  for (const field of ['matchSource', 'refiner'] as const) if (studio[field] !== undefined && typeof studio[field] !== 'boolean') invalid(`studio.${field} must be a boolean.`);
  const limits = { steps: [1, 100], cfg: [0, 30], seed: [0, Number.MAX_SAFE_INTEGER - Number(n) + 1], denoise: [Number.MIN_VALUE, 1], referenceStrength: [0, 2] };
  for (const [field, [min, max]] of Object.entries(limits)) {
    const value = studio[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || ['steps', 'seed'].includes(field) && !Number.isSafeInteger(value))) invalid(`studio.${field} is outside its supported range.`);
  }
  if (studio.operation !== undefined && (typeof studio.operation !== 'string' || !['text-to-image', 'image-to-image', 'reference'].includes(studio.operation))) invalid('Choose a supported studio.operation.');
  if (studio.outpaint !== undefined && (!object(studio.outpaint) || Object.keys(studio.outpaint).length !== 4 || ['left', 'right', 'top', 'bottom'].some(edge => !Number.isSafeInteger((studio.outpaint as Record<string, unknown>)[edge]) || Number((studio.outpaint as Record<string, unknown>)[edge]) < 0))) invalid('studio.outpaint must contain nonnegative integer left, right, top and bottom margins.');
  if (studio.loras !== undefined && (!Array.isArray(studio.loras) || studio.loras.length > 16 || studio.loras.some(item => !object(item) || Object.keys(item).some(key => !['id', 'strength'].includes(key)) || typeof item.id !== 'string' || !item.id || item.id.length > 128 || typeof item.strength !== 'number' || !Number.isFinite(item.strength)))) invalid('studio.loras must contain valid LoRA IDs and strengths.');
  const images = body.images ?? [];
  if (!Array.isArray(images) || images.length > 10 || editing && !images.length) invalid('Supply between 1 and 10 reference images for an edit.');
  if (body.mask !== undefined && !images.length) invalid('A mask requires a source image.');
  const input: Record<string, unknown> = { ...studio, modelId: body.model, prompt: body.prompt };
  if (body.background !== undefined) input.background = body.background;
  if (body.quality !== undefined && body.quality !== 'auto') input.quality = qualities[String(body.quality)];
  if (body.size !== undefined && body.size !== 'auto') {
    const size = typeof body.size === 'string' && /^(\d{2,5})x(\d{2,5})$/.exec(body.size);
    if (!size) invalid('size must be auto or WIDTHxHEIGHT, for example 1024x1024.');
    input.width = Number(size[1]); input.height = Number(size[2]);
  }
  const key = options.key ?? randomUUID();
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_.:-]{8,128}$/.test(key)) invalid('Use an Idempotency-Key of 8–128 letters, digits, dots, underscores, colons or dashes.');
  const requestKey = `openai:${hash(key)}`;
  const descriptor = async (value: unknown) => value instanceof File ? { filename: value.name, mimeType: value.type, sha256: hash(new Uint8Array(await value.arrayBuffer())) } : value;
  const fingerprint = hash(canonical({ editing, ...body, images: await Promise.all(images.map(descriptor)), ...(body.mask !== undefined ? { mask: await descriptor(body.mask) } : {}) }));
  options.authorize(); signal.throwIfAborted();
  media.bindRequest(userId, requestKey, fingerprint);
  const jobs: string[] = [];
  const headers = { 'Idempotency-Key': key, 'Cache-Control': 'private, no-store' };
  let prepared = false;
  try {
    for (let index = 0; index < Number(n); index++) {
      signal.throwIfAborted(); options.authorize();
      // The bound fingerprint already verifies the original request. Recover
      // accepted jobs even when their references have since been deleted.
      const existing = media.requestJob(userId, `${requestKey}:${index}`);
      if (existing) { jobs.push(existing); continue; }
      if (!prepared) {
        const model = (await engine.catalog()).models.find(model => model.id === body.model);
        if (!model) throw new ApiError(404, 'MODEL_NOT_FOUND', 'This image model is not in the Studio catalog.');
        const references = [];
        for (let source = 0; source < images.length; source++) {
          signal.throwIfAborted(); options.authorize();
          references.push(await media.image(userId, images[source], `${requestKey}:image:${source}`));
        }
        if (references.length) {
          input.images = references.map(image => image.id);
          input.operation ??= model.operations.includes('image-to-image') && references.length === 1 ? 'image-to-image' : 'reference';
        }
        if (body.mask !== undefined) input.maskId = (await media.openaiMask(userId, body.mask, references[0], `${requestKey}:mask`)).id;
        prepared = true;
      }
      signal.throwIfAborted(); options.authorize();
      const item = typeof input.seed === 'number' ? { ...input, seed: input.seed + index } : input;
      const job = await engine.submit(userId, item, `${requestKey}:${index}`);
      jobs.push(job.id);
    }
    const jobHeaders = { ...headers, 'X-Gravity-Job-Ids': jobs.join(','), Location: `/api/jobs/${jobs[0]}` };
    if (options.asynchronous) return Response.json({ created: Math.floor(Date.now() / 1000), data: [], jobs: jobs.map(id => publicJob(store.job(id, userId))) }, { status: 202, headers: jobHeaders });
    const deadline = Date.now() + (options.waitMs ?? 180_000);
    while (true) {
      signal.throwIfAborted(); options.authorize();
      const current = jobs.map(id => store.job(id, userId));
      if (current.some(job => ['failed', 'cancelled', 'interrupted'].includes(job.status))) throw new ImageRequestError(409, 'IMAGE_JOB_FAILED', 'An image job did not complete. Read its durable job status before retrying.', jobs);
      if (current.every(job => job.status === 'succeeded')) break;
      if (Date.now() >= deadline) throw new ImageRequestError(504, 'IMAGE_JOB_PENDING', 'The job is still queued or running. Poll /api/jobs/{id}, or retry the identical request with the same Idempotency-Key.', jobs);
      await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal });
    }
    const data: Record<string, unknown>[] = [];
    let totalBytes = 0;
    for (const id of jobs) {
      options.authorize(); signal.throwIfAborted();
      const job = store.job(id, userId), output = job.outputs[0];
      if (!output) throw new ImageRequestError(410, 'OUTPUT_NOT_FOUND', 'This completed image has been deleted. Create a new request to generate another image.', jobs);
      if (responseFormat === 'url') data.push({ url: `${options.origin}${media.ticket(userId, id, output.id, String(outputFormat), compression as number | undefined)}` });
      else {
        const result = await media.result(userId, id, output.id, String(outputFormat), compression as number | undefined);
        totalBytes += result.bytes.length;
        if (totalBytes > 128 * 1024 ** 2) throw new ImageRequestError(413, 'IMAGE_RESPONSE_TOO_LARGE', 'Use response_format=url or retrieve individual job outputs for this batch.', jobs);
        data.push({ b64_json: result.bytes.toString('base64') });
      }
    }
    return Response.json({ created: Math.floor(new Date(store.job(jobs[0], userId).createdAt).getTime() / 1000), data, output_format: outputFormat }, { headers: jobHeaders });
  } catch (error) {
    if (error instanceof ApiError && !(error instanceof ImageRequestError) && jobs.length) throw new ImageRequestError(error.status, error.code, error.message, jobs);
    throw error;
  }
}
