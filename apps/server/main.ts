import { resolve } from "node:path";
import { Store } from "./store.ts";
import { Engine } from "./engine.ts";
import { createStudioServer } from "./http.ts";

process.umask(0o077);
const directory = resolve(process.env.GRAVITY_DATA_DIR ?? "./storage");
const host = process.env.GRAVITY_HOST ?? "127.0.0.1";
const port = Number(process.env.GRAVITY_PORT ?? 7331);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("GRAVITY_PORT must be a TCP port between 1 and 65535.");
const allowedOrigins = (process.env.GRAVITY_ALLOWED_ORIGINS ?? "http://localhost:4321,http://127.0.0.1:4321").split(",").map(value => value.trim()).filter(Boolean);
const store = new Store(directory);
const engine = new Engine(store);
const server = await createStudioServer({ store, engine, allowedOrigins });
let closing = false;
async function close() {
  if (closing) return; closing = true;
  server.close();
  await engine.stop();
  server.closeAllConnections();
  store.close();
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
