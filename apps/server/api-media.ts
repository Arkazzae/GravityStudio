import { createHash, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { ApiError, type PublicInput } from '../../packages/contracts/index.ts';
import { requireActiveUser } from './administration.ts';
import { inputBytes, outputBytes, saveInput } from './media.ts';
import type { Store } from './store.ts';

export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(',')}}`;
  return JSON.stringify(value);
}
export class ApiMedia {
  private store: Store;
  private uploads = new Map<string, Promise<PublicInput>>();
  constructor(store: Store) {
    this.store = store;
  }
  bindRequest(userId: string, key: string, fingerprint: string) {
    requireActiveUser(this.store.db, userId);
    const old = this.store.db.prepare('SELECT hash FROM api_image_requests WHERE user_id=? AND key=?').get(userId, key);
    if (old && old.hash !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This request key already belongs to different image settings.');
    this.store.db.prepare('INSERT OR IGNORE INTO api_image_requests VALUES(?,?,?)').run(userId, key, fingerprint);
  }
  requestJob(userId: string, key: string): string | undefined {
    const row = this.store.db.prepare('SELECT job_id FROM idempotency WHERE user_id=? AND key=?').get(userId, key);
    return row ? this.store.job(String(row.job_id), userId).id : undefined;
  }
  upload(userId: string, bytes: Buffer, name: string, key: string): Promise<PublicInput> {
    requireActiveUser(this.store.db, userId);
    const fingerprint = hash(Buffer.concat([Buffer.from(`${name}\0`), bytes]));
    const lock = `${userId}:${key}`;
    const existing = this.store.db.prepare('SELECT hash,input_id FROM api_input_requests WHERE user_id=? AND key=?').get(userId, key);
    if (existing) {
      if (existing.hash !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This upload key already belongs to a different image.');
      const input = this.store.inputs(userId).find(input => input.id === existing.input_id);
      if (!input || this.store.db.prepare('SELECT 1 FROM input_deletions WHERE input_id=?').get(input.id)) throw new ApiError(409, 'REFERENCE_DELETED', 'The reference from this request was deleted. Use a new request key for a new image.');
      return Promise.resolve(input);
    }
    const pending = this.uploads.get(lock);
    if (pending) return pending.then(() => this.upload(userId, bytes, name, key));
    const operation = saveInput(this.store, userId, bytes, name).then(input => {
      this.store.db.prepare('INSERT INTO api_input_requests VALUES(?,?,?,?)').run(userId, key, fingerprint, input.id);
      return input;
    }).finally(() => this.uploads.delete(lock));
    this.uploads.set(lock, operation); return operation;
  }
  async inline(userId: string, input: { name: string; mimeType: string; data: string; idempotencyKey: string }) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(input.mimeType) || typeof input.name !== 'string' || !input.name || input.name.length > 160 || typeof input.idempotencyKey !== 'string' || !/^[a-zA-Z0-9_.:-]{8,128}$/.test(input.idempotencyKey) || typeof input.data !== 'string' || input.data.length > Math.ceil(2 * 1024 ** 2 / 3) * 4 || input.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new ApiError(400, 'INVALID_IMAGE_UPLOAD', 'Supply a PNG, JPEG or WebP as base64, up to 2 MiB, and a stable request key.');
    const bytes = Buffer.from(input.data, 'base64');
    if (bytes.toString('base64') !== input.data) throw new ApiError(400, 'INVALID_IMAGE_UPLOAD', 'Supply a valid base64 image.');
    if (!bytes.length || bytes.length > 2 * 1024 ** 2) throw new ApiError(413, 'INPUT_TOO_LARGE', 'Inline MCP images must be no larger than 2 MiB.');
    return this.upload(userId, bytes, input.name, `mcp:${hash(input.idempotencyKey)}`);
  }
  async image(userId: string, image: unknown, key: string): Promise<PublicInput> {
    if (image instanceof File) return this.upload(userId, Buffer.from(await image.arrayBuffer()), image.name, key);
    if (!image || typeof image !== 'object' || Array.isArray(image) || Object.keys(image).length !== 1) throw new ApiError(400, 'INVALID_IMAGE', 'Supply an uploaded file_id or a base64 image_url.');
    const value = image as { file_id?: unknown; image_url?: unknown };
    if (typeof value.file_id === 'string') {
      const input = this.store.inputs(userId).find(input => input.id === value.file_id);
      if (!input || this.store.db.prepare('SELECT 1 FROM input_deletions WHERE input_id=?').get(input.id)) throw new ApiError(404, 'INPUT_NOT_FOUND', 'This reference image does not exist.');
      return input;
    }
    const match = typeof value.image_url === 'string' && /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.image_url);
    if (!match || match[2].length % 4 || match[2].length > Math.ceil(20 * 1024 ** 2 / 3) * 4) throw new ApiError(400, 'INVALID_IMAGE', 'Use a base64 data URL or upload the image first. Remote image URLs are not fetched.');
    return this.upload(userId, Buffer.from(match[2], 'base64'), `reference.${match[1]}`, key);
  }
  async openaiMask(userId: string, image: unknown, source: PublicInput, key: string): Promise<PublicInput> {
    const input = await this.image(userId, image, `${key}:original`);
    if (input.width !== source.width || input.height !== source.height) throw new ApiError(400, 'INVALID_MASK', 'The mask must have the same dimensions as the first reference.');
    const bytes = await inputBytes(this.store, input.id, userId);
    const metadata = await sharp(bytes).metadata();
    if (!metadata.hasAlpha) throw new ApiError(400, 'INVALID_MASK', 'OpenAI masks need an alpha channel: transparent pixels mark the area to edit.');
    const mask = await sharp(bytes).extractChannel('alpha').negate().png().toBuffer();
    return this.upload(userId, mask, 'edit-mask.png', `${key}:converted`);
  }
  ticket(userId: string, jobId: string, outputId: string, format: string, compression?: number): string {
    requireActiveUser(this.store.db, userId);
    this.store.output(jobId, outputId, userId);
    const secret = randomBytes(32).toString('base64url');
    this.store.db.prepare('DELETE FROM api_downloads WHERE expires_at<=?').run(Date.now());
    this.store.db.prepare('INSERT INTO api_downloads VALUES(?,?,?,?,?,?,?)').run(hash(secret), userId, jobId, outputId, format, compression ?? null, Date.now() + 15 * 60_000);
    return `/api/downloads/${secret}`;
  }
  async download(secret: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const row = /^[a-zA-Z0-9_-]{43}$/.test(secret) ? this.store.db.prepare('SELECT * FROM api_downloads WHERE hash=? AND expires_at>?').get(hash(secret), Date.now()) : undefined;
    if (!row) throw new ApiError(404, 'DOWNLOAD_EXPIRED', 'This image link has expired or does not exist.');
    requireActiveUser(this.store.db, String(row.user_id));
    return this.result(String(row.user_id), String(row.job_id), String(row.output_id), String(row.format), row.compression === null ? undefined : Number(row.compression));
  }
  async result(userId: string, jobId: string, outputId: string, format: string, compression?: number) {
    const output = this.store.output(jobId, outputId, userId);
    const bytes = await outputBytes(this.store, jobId, outputId, userId);
    const mimeType = `image/${format}`;
    if (output.mimeType === mimeType && compression === undefined) return { bytes, mimeType };
    const image = sharp(bytes, { limitInputPixels: 80_000_000 });
    return { bytes: await (format === 'jpeg' ? image.flatten({ background: '#ffffff' }).jpeg({ quality: compression ?? 90 }) : format === 'webp' ? image.webp({ quality: compression ?? 90 }) : image.png()).toBuffer(), mimeType };
  }
}
