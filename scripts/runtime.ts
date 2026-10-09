import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { detectHardware } from "../packages/hardware/src/index.ts";
import { loadRuntimeEnvironment } from "./doctor.ts";
import type { ContainerEngineChoice } from "./doctor.ts";
import { runtimeWorkerSettings } from "./runtime-plan.ts";
import { prepareAutomaticRuntime } from "./runtime-auto.ts";
import { readRuntimeDeployment, smokeRuntimeDeployment, startRuntimeDeployment, stopRuntimeDeployment, writeRuntimeDeployment } from "./runtime-control.ts";

export function parseRuntimeArguments(args: string[]) {
  const command = args[0] && !args[0].startsWith("--") ? args.shift()! : "plan";
  if (!["plan", "prepare", "up", "smoke", "stop", "connections"].includes(command)) throw new Error("Usage: node scripts/runtime.ts [plan|prepare|up|smoke|stop|connections] [--engine auto|docker|podman] [--data-dir PATH] [--gpu ID] [--json]");
  let engine: ContainerEngineChoice = "auto", dataDirectory = resolve(process.env.GRAVITY_DATA_DIR ?? "storage"), json = false, portBase: number | undefined;
  const gpuIds: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") { json = true; continue; }
    if (!["--engine", "--data-dir", "--gpu", "--port"].includes(arg) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Invalid runtime argument: ${arg}`);
    const value = args[++index];
    if (arg === "--engine") { if (value !== "auto" && value !== "docker" && value !== "podman") throw new Error("Choose auto, Docker or Podman."); engine = value; }
    if (arg === "--data-dir") dataDirectory = resolve(value);
    if (arg === "--gpu") gpuIds.push(value);
    if (arg === "--port") { portBase = Number(value); if (!Number.isInteger(portBase) || portBase < 1024 || portBase > 65535) throw new Error("Choose a worker port between 1024 and 65535."); }
  }
  return { command, engine, dataDirectory, gpuIds: gpuIds.length ? gpuIds : undefined, json, portBase };
}

async function main() {
  loadRuntimeEnvironment();
  const options = parseRuntimeArguments(process.argv.slice(2));
  if (options.command === "connections") { console.log(JSON.stringify({ version: 1, kind: "gravity-worker-settings", workers: runtimeWorkerSettings(await readRuntimeDeployment(options.dataDirectory)) }, null, 2)); return; }
  if (options.command === "stop") { await stopRuntimeDeployment(await readRuntimeDeployment(options.dataDirectory)); console.log("Managed workers stopped. Models and outputs were retained."); return; }
  const inventory = await detectHardware();
  if (options.command === "smoke") { console.log(JSON.stringify(await smokeRuntimeDeployment(await readRuntimeDeployment(options.dataDirectory), inventory), null, 2)); return; }
  const { plan, preflight } = await prepareAutomaticRuntime(inventory, options.dataDirectory, options);
  if (options.command === "plan") {
    if (options.json) console.log(JSON.stringify({ plan, preflight, inventory }, null, 2));
    else {
      console.log(`Managed ComfyUI plan: ${plan.engine}, ${plan.workers.length} worker(s), ${plan.build.length} shared runtime image(s).`);
      for (const diagnostic of plan.diagnostics.filter((item) => item.severity !== "error")) console.log(`${diagnostic.severity.toUpperCase()}: ${diagnostic.message}`);
      for (const check of preflight.checks) console.log(`${check.status.toUpperCase()}: ${check.message}`);
      for (const worker of plan.workers) console.log(`${worker.gpuId} → ${worker.baseUrl}`);
      console.log("Run 'pnpm runtime up' to prepare, build, start and smoke-test workers automatically.");
    }
    if (!preflight.ready) process.exitCode = 1;
    return;
  }
  if (!preflight.ready) {
    if (options.json) console.log(JSON.stringify({ plan, preflight }, null, 2));
    else for (const check of preflight.checks.filter((check) => check.status === "failed")) console.error(`${check.status.toUpperCase()}: ${check.message}`);
    process.exitCode = 1;
    return;
  }
  if (options.command === "prepare") { await writeRuntimeDeployment(plan); console.log(JSON.stringify({ composeFile: plan.composeFile, diagnostics: plan.diagnostics, preflight }, null, 2)); return; }
  await startRuntimeDeployment(plan);
  const results = await smokeRuntimeDeployment(plan, inventory);
  console.log(JSON.stringify({ workers: plan.workers.map(({ id, gpuId, baseUrl }) => ({ id, gpuId, baseUrl })), verification: results, modelsDirectory: plan.modelsDirectory }, null, 2));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch((error) => { console.error(error instanceof Error ? error.message : "Managed-runtime operation failed."); process.exitCode = 1; });
