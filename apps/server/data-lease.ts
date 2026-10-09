import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A kernel-backed lease shared by the server and offline storage maintenance.
 * A separate database keeps the application database available for backups.
 * SQLite releases this lock even when its owner crashes or is killed. */
export function acquireDataLease(directory: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, ".process-lock.sqlite");
  const lease = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    lease.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY)");
  } catch {
    lease.close();
    throw new Error("This data directory is already in use. Stop Studio and other storage maintenance before continuing.");
  }
  let released = false;
  return () => { if (!released) { released = true; lease.close(); } };
}
