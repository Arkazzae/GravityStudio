import { resolve } from "node:path";
import { Store } from "./store.ts";
import { Engine } from "./engine.ts";
import { createStudioServer } from "./http.ts";
import { objectStoreFromEnv } from "./object-store.ts";
import { acquireDataLease } from "./data-lease.ts";

process.umask(0o077);
const directory = resolve(process.env.GRAVITY_DATA_DIR ?? "./storage");
const host = process.env.GRAVITY_HOST ?? "127.0.0.1";
const port = Number(process.env.GRAVITY_PORT ?? 7331);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("GRAVITY_PORT must be a TCP port between 1 and 65535.");
const allowedOrigins = (process.env.GRAVITY_ALLOWED_ORIGINS ?? "http://localhost:4321,http://127.0.0.1:4321").split(",").map(value => value.trim()).filter(Boolean);
const objectStore = objectStoreFromEnv(process.env);
let releaseLease: () => void;
try { releaseLease = acquireDataLease(directory); }
catch (error) { objectStore?.close(); throw error; }
let store: Store;
try { store = new Store(directory, { objectStore }); }
catch (error) { objectStore?.close(); releaseLease(); throw error; }
const engine = new Engine(store);
let server: Awaited<ReturnType<typeof createStudioServer>>;
try { server = await createStudioServer({ store, engine, allowedOrigins }); }
catch (error) { objectStore?.close(); store.close(); releaseLease(); throw error; }
let closing = false;
async function close() {
  if (closing) return; closing = true;
  const drained = new Promise<void>(resolve => server.close(() => resolve()));
  // Request bodies already have a 60 s deadline. Bound clients that keep an
  // accepted connection open, while retaining SQLite until media writes finish.
  const deadline = setTimeout(() => server.closeAllConnections(), 65_000); deadline.unref();
  try {
    const results = await Promise.allSettled([server.closeOperations(), engine.stop(), drained]);
    if (results.some(result => result.status === 'rejected')) process.exitCode = 1;
  } finally {
    clearTimeout(deadline); objectStore?.close(); store.close(); releaseLease();
  }
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  server.on("error", error => { console.error("Studio API:", error.message); process.exitCode = 1; void close(); });
  console.log(`Gravity API is listening at http://${host}:${port}`);
  if (!store.owner()) console.log(`Create the owner account in Studio. Your setup key is stored in ${resolve(directory, "setup.key")}`);
  if (!closing) await engine.start();
} catch (error) {
  console.error("Studio API:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
  await close();
}
