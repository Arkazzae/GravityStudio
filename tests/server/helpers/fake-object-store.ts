import { createHash } from 'node:crypto';
import { ApiError } from '../../../packages/contracts/index.ts';
import type { AssetObjectStore, StoredObject } from '../../../apps/server/object-store.ts';

export class FakeObjectStore implements AssetObjectStore {
  readonly id: string;
  objects = new Map<string, Buffer>();
  puts: string[] = [];
  gets: string[] = [];
  deletes: string[] = [];
  failPut = false;
  failGet = false;
  failDelete = false;
  beforePut?: () => Promise<void>;
  beforeDelete?: () => Promise<void>;
  constructor(id = 'fixture-object-store') { this.id = id; }
  async put(location: string, data: Uint8Array, _mimeType: string): Promise<StoredObject> {
    this.puts.push(location);
    await this.beforePut?.();
    if (this.failPut) throw new ApiError(503, 'ASSET_WRITE_FAILED', 'Object storage is temporarily unavailable.');
    const bytes = Buffer.from(data), sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = `fixture/${location}/${sha256}`;
    this.objects.set(key, bytes);
    return { backend: 's3', storeId: this.id, key, sha256, bytes: bytes.length };
  }
  async get(ref: StoredObject, maxBytes: number): Promise<Buffer> {
    this.gets.push(ref.key);
    if (this.failGet) throw new ApiError(503, 'ASSET_READ_FAILED', 'Object storage is temporarily unavailable.');
    const bytes = this.objects.get(ref.key);
    if (!bytes || bytes.length > maxBytes || bytes.length !== ref.bytes || createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new ApiError(503, 'ASSET_INTEGRITY_ERROR', 'Object storage could not verify the saved image.');
    return Buffer.from(bytes);
  }
  async delete(ref: StoredObject): Promise<void> {
    this.deletes.push(ref.key);
    await this.beforeDelete?.();
    if (this.failDelete) throw new ApiError(503, 'ASSET_DELETE_FAILED', 'Object storage is temporarily unavailable.');
    this.objects.delete(ref.key);
  }
  close() {}
}
