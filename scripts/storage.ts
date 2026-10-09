import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadRuntimeEnvironment } from "./doctor.ts";
import { Store } from "../apps/server/store.ts";
import { acquireDataLease } from "../apps/server/data-lease.ts";
import { objectStoreFromEnv, s3ObjectStoreConfig, type AssetObjectStore } from "../apps/server/object-store.ts";
import { initializeObjectBucket } from "../apps/server/storage-admin.ts";
import { migrateAssets, storageStatus } from "../apps/server/storage-migration.ts";

export function parseStorageArguments(args: string[]) {
  const command = args[0] && !args[0].startsWith("--") ? args.shift()! : "status";
  if (!["status", "init", "migrate"].includes(command)) throw new Error("Usage: pnpm storage [status|init|migrate] [--data-dir PATH]");
  let directory = resolve(process.env.GRAVITY_DATA_DIR ?? "storage");
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--data-dir" || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Use --data-dir PATH to select the Studio data directory.");
    directory = resolve(args[++i]);
  }
  return { command, directory };
}

async function main() {
  process.umask(0o077);
  loadRuntimeEnvironment();
  const { command, directory } = parseStorageArguments(process.argv.slice(2));
  if (command === "status") {
    const db = new DatabaseSync(join(directory, "studio.sqlite"), { readOnly: true });
    try { console.log(JSON.stringify({ primary: process.env.GRAVITY_ASSET_STORAGE ?? "local", ...storageStatus(db) }, null, 2)); }
    finally { db.close(); }
    return;
  }
  if (process.env.GRAVITY_ASSET_STORAGE !== "s3") throw new Error("Set GRAVITY_ASSET_STORAGE=s3 and configure the private S3 connection first.");
  if (command === "init") {
    await initializeObjectBucket(s3ObjectStoreConfig());
    console.log("Private bucket ready. Write, read-back and deletion checks passed.");
    return;
  }
  const release = acquireDataLease(directory);
  let objects: AssetObjectStore | null = null;
  let store: Store | undefined;
  try {
    objects = objectStoreFromEnv();
    store = new Store(directory, { objectStore: objects });
    console.log(JSON.stringify(await migrateAssets(store), null, 2));
  } finally { store?.close(); objects?.close(); release(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(error instanceof Error ? error.message : "Storage maintenance failed."); process.exitCode = 1; });
