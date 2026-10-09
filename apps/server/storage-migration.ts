import { backup, DatabaseSync } from "node:sqlite";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Store, StoredInput, StoredOutput } from "./store.ts";
import { MAX_OUTPUT_BYTES } from "./media.ts";

type AssetRow = { id: string; body: string; job_id?: string };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function storageStatus(db: DatabaseSync) {
  const counts = (table: "inputs" | "outputs") => db.prepare(`SELECT
    count(*) AS total,
    coalesce(sum(CASE WHEN json_extract(body,'$.object.backend')='s3' THEN 1 ELSE 0 END),0) AS s3,
    coalesce(sum(CASE WHEN json_extract(body,'$.object.backend')='s3' THEN 0 ELSE 1 END),0) AS local,
    coalesce(sum(json_extract(body,'$.bytes')),0) AS bytes FROM ${table}`).get();
  const pendingInputs = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='input_deletions'").get()
    ? (db.prepare("SELECT count(*) AS count FROM input_deletions").get() as { count: number }).count : 0;
  return { inputs: counts("inputs"), outputs: counts("outputs"),
    pendingDeletions: (db.prepare("SELECT count(*) AS count FROM output_deletions").get() as { count: number }).count + pendingInputs };
}

async function localBytes(store: Store, table: "inputs" | "outputs", row: AssetRow, asset: StoredInput | StoredOutput): Promise<Buffer> {
  const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<string, string>)[asset.mimeType];
  if (!extension || (table === "inputs" ? !UUID.test(row.id) : !UUID.test(row.job_id ?? "") || !/^[a-f0-9]{32}$/.test(row.id))) throw new Error("The asset has an invalid local identity.");
  const root = resolve(store.directory, table);
  const parent = table === "inputs" ? root : join(root, row.job_id!);
  const expected = join(parent, `${row.id}.${table === "inputs" ? "png" : extension}`);
  if (!asset.path || resolve(asset.path) !== expected) throw new Error("The asset path is outside its registered local location.");
  for (const directory of new Set([root, parent])) if (!(await lstat(directory)).isDirectory()) throw new Error("The asset directory is not a regular directory.");
  const file = await open(expected, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_OUTPUT_BYTES || info.size !== asset.bytes) throw new Error("The local asset does not match its registered size.");
    const bytes = await file.readFile();
    if (bytes.length !== info.size || "sha256" in asset && createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("The local asset does not match its registered checksum.");
    return bytes;
  } finally { await file.close(); }
}

/** Caller holds acquireDataLease for the entire operation. Each verified asset
 * commits independently; interruption is resumable and local copies are retained. */
export async function migrateAssets(store: Store, progress?: (migrated: number) => void) {
  const objects = store.objectStore;
  if (!objects) throw new Error("Configure S3 as the primary asset storage before migration.");
  if (store.activeJobs().length) throw new Error("Finish or cancel active generations before migrating storage.");
  const directory = join(store.directory, "backups");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const backupPath = join(directory, `before-s3-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.sqlite`);
  await backup(store.db, backupPath);
  await chmod(backupPath, 0o600);
  let migrated = 0, verified = 0, skippedDeletions = 0;
  for (const table of ["inputs", "outputs"] as const) {
    const rows = store.db.prepare(`SELECT id,body${table === "outputs" ? ",job_id" : ""} FROM ${table} ORDER BY id`).all() as AssetRow[];
    for (const row of rows) {
      const pendingDeletion = table === "inputs" ? store.db.prepare("SELECT 1 FROM input_deletions WHERE input_id=?").get(row.id) : store.db.prepare("SELECT 1 FROM output_deletions WHERE output_id=?").get(row.id);
      if (pendingDeletion) { skippedDeletions++; continue; }
      const asset = JSON.parse(row.body) as StoredInput | StoredOutput;
      if (asset.object) { await objects.get(asset.object, MAX_OUTPUT_BYTES); verified++; continue; }
      const bytes = await localBytes(store, table, row, asset);
      const location = table === "inputs" ? `inputs/${row.id}` : `outputs/${row.job_id}/${row.id}`;
      const object = await objects.put(location, bytes, asset.mimeType);
      // Verify the downloaded bytes independently before switching the record.
      const readback = await objects.get(object, MAX_OUTPUT_BYTES);
      if (!readback.equals(bytes)) throw new Error("The uploaded asset failed read-back verification.");
      const changed = store.db.prepare(`UPDATE ${table} SET body=? WHERE id=? AND body=?`).run(JSON.stringify({ ...asset, object }), row.id, row.body);
      if (changed.changes !== 1) throw new Error("An asset changed during offline migration. Stop all Studio processes before retrying.");
      migrated++; progress?.(migrated);
    }
  }
  return { migrated, verified, skippedDeletions, backupPath, ...storageStatus(store.db) };
}
