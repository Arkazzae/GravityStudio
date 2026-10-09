import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../apps/server/store.ts";
import { acquireDataLease } from "../../apps/server/data-lease.ts";
import { migrateAssets, storageStatus } from "../../apps/server/storage-migration.ts";
import type { AssetObjectStore, StoredObject } from "../../apps/server/object-store.ts";
import { saveInput, saveOutput, inputBytes } from "../../apps/server/media.ts";
import { PNG } from "../inference/fake-comfy.ts";

class Objects implements AssetObjectStore {
  id = "fixture-s3";
  data = new Map<string, Buffer>();
  failAt = Infinity;
  puts = 0;
  corrupt = false;
  async put(location: string, bytes: Uint8Array): Promise<StoredObject> {
    if (++this.puts === this.failAt) throw new Error("storage unavailable");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const key = `media-v1/${location}/${sha256}`;
    this.data.set(key, Buffer.from(bytes));
    return { backend: "s3", storeId: this.id, key, sha256, bytes: bytes.length };
  }
  async get(ref: StoredObject) { return this.corrupt ? Buffer.from("corrupt") : Buffer.from(this.data.get(ref.key)!); }
  async delete(ref: StoredObject) { this.data.delete(ref.key); }
  close() {}
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "gravity-storage-migration-"));
  let store = new Store(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = store.createOwner("owner", "fixture");
  const input = await saveInput(store, owner.id, Buffer.from(PNG), "reference.png");
  const job = store.createJob(owner.id, { modelId: "sdxl-base", prompt: "Persist metadata" }, {}, [], "SDXL", {}, "migrate", "migrate");
  const output = await saveOutput(store, job.id, 0, PNG);
  store.patchJob(job.id, { status: "preparing" });
  store.patchJob(job.id, { status: "succeeded", outputs: [output] });
  store.setOutputFavorite(job.id, output.id, owner.id, true);
  const objects = new Objects();
  store.close(); store = new Store(directory, { objectStore: objects });
  return { directory, store, objects, owner, input, output, job };
}

test("the data lease excludes another process connection and releases without a stale PID file", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gravity-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = acquireDataLease(directory);
  assert.throws(() => acquireDataLease(directory), /already in use/);
  release(); release();
  const next = acquireDataLease(directory);
  assert.throws(() => acquireDataLease(directory), /already in use/);
  next();
});

test("migration verifies assets, preserves URLs and favorites, retains rollback copies and makes a private database backup", async t => {
  const f = await fixture(t);
  const originalJob = f.store.job(f.job.id);
  const originalInput = f.store.input(f.input.id, f.owner.id);
  const originalOutput = f.store.output(f.job.id, f.output.id, f.owner.id);
  const result = await migrateAssets(f.store);
  assert.equal(result.migrated, 2);
  assert.equal(result.verified, 0);
  assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600);
  const backup = new DatabaseSync(result.backupPath, { readOnly: true });
  try { assert.equal((storageStatus(backup).outputs as { local: number }).local, 1); }
  finally { backup.close(); }
  assert.deepEqual(f.store.job(f.job.id), originalJob);
  assert.deepEqual(f.store.inputs(f.owner.id), [f.input]);
  assert.equal(f.store.output(f.job.id, f.output.id, f.owner.id).path, originalOutput.path);
  assert.deepEqual(await readFile(originalOutput.path!), Buffer.from(PNG));
  assert.deepEqual(await inputBytes(f.store, f.input.id, f.owner.id), await readFile(originalInput.path!));
  assert.equal(f.store.input(f.input.id, f.owner.id).object!.storeId, f.objects.id);
  const retry = await migrateAssets(f.store);
  assert.equal(retry.migrated, 0); assert.equal(retry.verified, 2);
  assert.equal(f.objects.data.size, 2);
});

test("interrupted migration resumes per asset and never flips an unverified record", async t => {
  const f = await fixture(t);
  f.objects.failAt = 2;
  await assert.rejects(migrateAssets(f.store), /storage unavailable/);
  assert.ok(f.store.input(f.input.id, f.owner.id).object);
  assert.equal(f.store.output(f.job.id, f.output.id, f.owner.id).object, undefined);
  f.objects.failAt = Infinity;
  const result = await migrateAssets(f.store);
  assert.equal(result.migrated, 1); assert.equal(result.verified, 1);
  assert.equal(f.objects.data.size, 2);
});

test("failed read-back leaves the local asset authoritative for a later retry", async t => {
  const f = await fixture(t);
  f.objects.corrupt = true;
  await assert.rejects(migrateAssets(f.store), /read-back verification/);
  assert.equal(f.store.input(f.input.id, f.owner.id).object, undefined);
  f.objects.corrupt = false;
  assert.equal((await migrateAssets(f.store)).migrated, 2);
  assert.equal(f.objects.data.size, 2);
});

test("migration checks local checksums and skips images already pending deletion", async t => {
  const f = await fixture(t);
  const output = f.store.output(f.job.id, f.output.id, f.owner.id);
  const changed = Buffer.from(PNG); changed[changed.length - 1] ^= 1;
  await writeFile(output.path!, changed);
  await assert.rejects(migrateAssets(f.store), /checksum/);
  assert.equal(f.store.output(f.job.id, f.output.id, f.owner.id).object, undefined);
  f.store.beginOutputDeletion(f.job.id, f.output.id, f.owner.id);
  const result = await migrateAssets(f.store);
  assert.equal(result.skippedDeletions, 1);
  assert.equal(result.migrated, 0);
  assert.equal(f.objects.data.size, 1);
});
