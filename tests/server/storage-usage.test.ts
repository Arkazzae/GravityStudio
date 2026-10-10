import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { lstat, link, mkdir, mkdtemp, opendir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { BigIntStatsFs } from "node:fs";
import { StorageUsageService } from "../../apps/server/storage-usage.ts";
import type { AssetObjectStore } from "../../apps/server/object-store.ts";
import { BIREFNET_ARTIFACT, UPSCALER_MODELS } from "../../packages/inference/index.ts";

async function fixture(t: TestContext, remote = false) {
  const directory = await mkdtemp(join(tmpdir(), "gravity-storage-usage-"));
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE inputs(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE outputs(id TEXT PRIMARY KEY,body TEXT NOT NULL)");
  const objectStore: AssetObjectStore | null = remote ? {
    id: "fixture-store", put: async () => { throw new Error("Usage must not write objects"); },
    get: async () => { throw new Error("Usage must not download objects"); },
    delete: async () => { throw new Error("Usage must not delete objects"); }, close() {},
  } : null;
  const store = { directory, db, objectStore };
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const file = async (path: string, bytes: number) => { const target = join(directory, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, Buffer.alloc(bytes)); return target; };
  const record = (table: "inputs" | "outputs", id: string, bytes: number, extra: Record<string, unknown> = {}) => db.prepare(`INSERT INTO ${table}(id,body) VALUES(?,?)`).run(id, JSON.stringify({ bytes, object: { backend: "s3", storeId: "fixture-store", key: `${table}/${id}`, bytes }, ...extra }));
  return { directory, db, store, file, record };
}
const filesystem = { type: 1n, bsize: 4096n, blocks: 1000n, bfree: 400n, bavail: 350n, files: 1000n, ffree: 900n } as BigIntStatsFs;

test("volume capacity distinguishes disk usage, free blocks and process-available space", async t => {
  const f = await fixture(t);
  const service = new StorageUsageService(f.store, { fs: { statfs: async () => filesystem } });
  const result = await service.view();
  assert.deepEqual({ total: result.volume.totalBytes, used: result.volume.usedBytes, free: result.volume.freeBytes, available: result.volume.availableBytes }, { total: 4096000, used: 2457600, free: 1638400, available: 1433600 });
  assert.equal(result.volume.status, "available");
  assert.match(result.volume.message!, /other applications/);
  assert.equal(result.local.status, "complete"); assert.equal(result.local.bytes, 0);
  assert.equal(result.objectStorage.configured, false); assert.equal(result.objectStorage.bytes, null);
});

test("one scan measures image models, MiMo, shared upscaler weights, SQLite, images and worker files", async t => {
  const f = await fixture(t);
  const checkpoint = await f.file("models/checkpoints/model.safetensors", 101);
  await f.file("models/text/mimo.gguf", 202);
  await f.file(`models/${BIREFNET_ARTIFACT.folder}/${BIREFNET_ARTIFACT.filename}`, 303);
  const seed = UPSCALER_MODELS.find(model => model.id === "seedvr2-3b")!;
  for (const artifact of seed.artifacts) await f.file(`models/${artifact.folder}/${artifact.filename}`, 404);
  await f.file("models/upscale_models/downloading.safetensors.part", 50);
  await f.file("studio.sqlite", 505); await f.file("studio.sqlite-wal", 51); await f.file(".process-lock.sqlite-shm", 52);
  await f.file("inputs/image.png", 606); await f.file("outputs/job/image.png", 60);
  await f.file("runtime/worker-1/output/work.png", 707); await f.file("setup.key", 808);
  await link(checkpoint, join(f.directory, "checkpoint-hardlink"));
  const result = await new StorageUsageService(f.store).view();
  assert.equal(result.local.status, "complete");
  const amounts = Object.fromEntries(result.local.categories.map(item => [item.id, item.bytes]));
  assert.deepEqual(amounts, { "image-models": 101, "language-models": 202, tools: 1161, database: 608, images: 666, runtime: 707, other: 808 });
  assert.equal(result.local.bytes, Object.values(amounts).reduce<number>((sum, value) => sum + value!, 0));
  assert.equal(result.local.files, 13, "the hard link is not counted twice");
  assert(result.local.allocatedBytes! >= result.local.bytes!);
  assert(result.largestModelFiles.every(file => !file.name.startsWith("/") && !file.name.includes(f.directory)));
  assert.equal(result.largestModelFiles[0].bytes, 404);
  assert.equal(result.largestModelFiles.filter(file => file.categoryId === "tools").length, 4);
  assert.equal(result.modelFilesTruncated, false);
});

test("model details retain only the largest20 weights without an additional directory walk", async t => {
  const f = await fixture(t);
  for (let index = 1; index <= 25; index++) await f.file(`models/checkpoints/weight-${index}.safetensors`, index * 100);
  await f.file("models/checkpoints/config.json", 10000);
  const opened: string[] = [];
  const result = await new StorageUsageService(f.store, { fs: { openDirectory: async path => { opened.push(path); return opendir(path); } } }).view();
  assert.equal(result.largestModelFiles.length, 20); assert.equal(result.modelFilesTruncated, true);
  assert.equal(result.largestModelFiles[0].bytes, 2500); assert.equal(result.largestModelFiles[19].bytes, 600);
  assert.equal(result.local.categories.find(item => item.id === "image-models")!.bytes, 42500);
  assert.equal(new Set(opened).size, opened.length);
});

test("symlink files and directories never contribute their external target sizes", async t => {
  const f = await fixture(t), outside = await mkdtemp(join(tmpdir(), "gravity-storage-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.safetensors"), Buffer.alloc(9000));
  await f.file("models/checkpoints/inside.safetensors", 17);
  await symlink(outside, join(f.directory, "models", "outside"));
  await symlink(join(outside, "secret.safetensors"), join(f.directory, "models", "file.safetensors"));
  const opened: string[] = [];
  const result = await new StorageUsageService(f.store, { fs: { openDirectory: async path => { opened.push(path); return opendir(path); } } }).view();
  assert.equal(result.local.bytes, 17); assert.equal(result.local.status, "partial");
  assert.equal(result.largestModelFiles.length, 1); assert.equal(result.modelFilesTruncated, true);
  assert(result.local.warnings.some(message => /Symbolic links/.test(message)));
  assert(opened.every(path => !path.includes("outside")));
});

test("a model-root symlink is unavailable instead of silently reporting empty models", async t => {
  const f = await fixture(t), outside = await mkdtemp(join(tmpdir(), "gravity-storage-models-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.safetensors"), Buffer.alloc(9000));
  await symlink(outside, join(f.directory, "models"));
  const result = await new StorageUsageService(f.store).view();
  assert.equal(result.local.status, "partial");
  assert.equal(result.local.categories.find(item => item.id === "image-models")!.bytes, null);
  assert.equal(result.largestModelFiles.length, 0);
});

test("missing or inaccessible storage reports unavailable or partial measurements without fake zeros", async t => {
  const f = await fixture(t);
  const gone = await new StorageUsageService({ ...f.store, directory: join(f.directory, "missing") }).view();
  assert.equal(gone.volume.status, "unavailable"); assert.equal(gone.volume.totalBytes, null);
  assert.equal(gone.local.status, "unavailable"); assert.equal(gone.local.bytes, null);
  await f.file("models/text/mimo.gguf", 500); await f.file("inputs/image.png", 29);
  const result = await new StorageUsageService(f.store, { fs: { openDirectory: async path => {
    if (path.endsWith("/models/text")) throw Object.assign(new Error("private denied filesystem path"), { code: "EACCES" });
    return opendir(path);
  }, statfs: async () => { throw new Error("private capacity diagnostic"); } } }).view();
  assert.equal(result.volume.availableBytes, null); assert.equal(result.local.bytes, 29); assert.equal(result.local.status, "partial");
  assert.notEqual(result.local.categories.find(item => item.id === "language-models")!.status, "complete");
  assert(!JSON.stringify(result).includes("private"));
});

test("entry limits return explicitly partial lower bounds and close opened directories", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 20; index++) await f.file(`inputs/${index}.png`, 10);
  const dirs: Awaited<ReturnType<typeof opendir>>[] = [];
  const result = await new StorageUsageService(f.store, { maxEntries: 4, fs: { openDirectory: async path => { const dir = await opendir(path); dirs.push(dir); return dir; } } }).view();
  assert.equal(result.local.status, "partial"); assert(result.local.bytes! < 200);
  assert(result.local.warnings.some(message => /entry limit/.test(message)));
  for (const dir of dirs) await assert.rejects(dir.read(), { code: "ERR_DIR_CLOSED" });
});

test("recorded S3 bytes are separate from local images, deduplicated and never read from the bucket", async t => {
  const f = await fixture(t, true);
  f.record("inputs", "one", 101); f.record("outputs", "two", 202);
  f.record("outputs", "same-object", 202, { object: { backend: "s3", storeId: "fixture-store", key: "outputs/two", bytes: 202 } });
  f.record("inputs", "legacy-local", 303, { object: undefined, path: join(f.directory, "inputs", "legacy.png") });
  await f.file("inputs/legacy.png", 303);
  const result = await new StorageUsageService(f.store).view();
  assert.equal(result.local.bytes, 303);
  assert.deepEqual({ bytes: result.objectStorage.bytes, inputs: result.objectStorage.inputsBytes, outputs: result.objectStorage.outputsBytes, files: result.objectStorage.files, status: result.objectStorage.status }, { bytes: 303, inputs: 101, outputs: 202, files: 2, status: "complete" });
  assert.match(result.objectStorage.message, /not bucket capacity/);
});

test("unknown object sizes and bounded registry pages cannot be presented as complete totals", async t => {
  const f = await fixture(t, true);
  f.record("inputs", "valid", 10); f.record("inputs", "invalid", 20, { object: { backend: "s3", storeId: "fixture-store", key: "inputs/invalid" } });
  f.db.prepare("INSERT INTO outputs(id,body) VALUES(?,?)").run("corrupt", "not-json");
  const result = await new StorageUsageService(f.store).view();
  assert.equal(result.objectStorage.status, "partial"); assert.equal(result.objectStorage.bytes, 10); assert.equal(result.objectStorage.unknownSizeFiles, 2);
  for (let index = 0; index < 140; index++) f.record("inputs", `extra-${index}`, 1);
  const bounded = await new StorageUsageService(f.store, { maxRecords: 130 }).view();
  assert.equal(bounded.objectStorage.status, "partial"); assert(bounded.objectStorage.files <= 130);
  assert.match(bounded.objectStorage.message, /lower bounds/);
});

test("metadata database failures report unavailable object bytes", async t => {
  const f = await fixture(t, true);
  f.db.exec("DROP TABLE inputs; DROP TABLE outputs");
  const result = await new StorageUsageService(f.store).view();
  assert.equal(result.objectStorage.status, "unavailable"); assert.equal(result.objectStorage.bytes, null);
});

test("concurrent callers share a cached scan without sharing mutable results", async t => {
  const f = await fixture(t); await f.file("inputs/one.png", 25);
  let now = 1000, calls = 0, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const service = new StorageUsageService(f.store, { now: () => now, cacheMs: 100, fs: { statfs: async () => { calls++; await pending; return filesystem; } } });
  const first = service.view(), second = service.view(); release();
  const [a, b] = await Promise.all([first, second]); assert.equal(calls, 1);
  a.local.categories[0].bytes = 999; assert.notEqual(b.local.categories[0].bytes, 999);
  await f.file("inputs/two.png", 30);
  assert.equal((await service.view()).local.bytes, 25); assert.equal(calls, 1);
  now += 101;
  assert.equal((await service.view()).local.bytes, 55); assert.equal(calls, 2);
});

test("a separately configured model filesystem is measured once and warns about capacity scope", async t => {
  const f = await fixture(t), models = await mkdtemp(join(tmpdir(), "gravity-storage-separated-"));
  t.after(() => rm(models, { recursive: true, force: true }));
  await writeFile(join(models, "other.safetensors"), Buffer.alloc(47));
  const result = await new StorageUsageService(f.store, { modelsDirectory: models, fs: { lstat: async path => {
    const info = await lstat(path, { bigint: true });
    if (path === models) info.dev += 1n;
    return info;
  } } }).view();
  assert.equal(result.local.bytes, 47); assert.equal(result.local.status, "complete");
  assert(result.local.warnings.some(message => /different filesystem/.test(message)));
  assert.deepEqual(result.largestModelFiles.map(file => file.name), ["other.safetensors"]);
});
