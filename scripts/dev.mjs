import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
try { process.loadEnvFile(resolve(root, ".env")); } catch (error) { if (error.code !== "ENOENT") throw error; }
const production = process.argv.includes("--production");
const children = [
  spawn(process.execPath, [...(production ? [] : ["--watch"]), "apps/server/main.ts"], { cwd: root, env: process.env, stdio: "inherit" }),
  spawn(process.execPath, ["apps/studio/node_modules/next/dist/bin/next", production ? "start" : "dev", ...(production ? [] : ["--webpack"]), "--hostname", process.env.GRAVITY_STUDIO_HOST ?? "127.0.0.1", "--port", process.env.GRAVITY_STUDIO_PORT ?? "4321", "apps/studio"], { cwd: root, env: process.env, stdio: "inherit" }),
];
let closing = false;
function stop(code = 0) {
  if (closing) return; closing = true; process.exitCode = code;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
}
for (const child of children) { child.on("error", error => { console.error(error.message); stop(1); }); child.on("exit", code => { if (!closing) stop(code ?? 1); }); }
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
