import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { detectHardware } from "../packages/hardware/src/index.ts";
import type { HardwareInventory } from "../packages/hardware/src/index.ts";
import type { ContainerEngine } from "./runtime-plan.ts";

const execute = promisify(execFile);
const cudaProfileDriverMinimum = [570, 124, 6];
function meetsCudaProfileDriverMinimum(version: string | null): boolean {
  if (!version || !/^\d+\.\d+(?:\.\d+)?$/.test(version)) return false;
  const components = version.split(".").map(Number);
  for (let index = 0; index < cudaProfileDriverMinimum.length; index++) {
    const difference = (components[index] ?? 0) - cudaProfileDriverMinimum[index];
    if (difference !== 0) return difference > 0;
  }
  return true;
}
export interface PreflightCheck { id: string; status: "passed" | "warning" | "failed"; message: string }
export interface PreflightProbe {
  command(file: string, args: string[]): Promise<string>;
  deviceGroups(): Promise<number[]>;
}
const defaultProbe: PreflightProbe = {
  async command(file, args) { return (await execute(file, args, { timeout: 5000, maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true })).stdout; },
  async deviceGroups() {
    const render = (await readdir("/dev/dri")).filter((name) => /^renderD\d+$/.test(name));
    const entries = await Promise.all([stat("/dev/kfd"), ...render.map((name) => stat(`/dev/dri/${name}`))]);
    return [...new Set(entries.map((entry) => entry.gid))];
  },
};

export async function inspectRuntimePrerequisites(inventory: HardwareInventory, engine: ContainerEngine = "docker", probe: PreflightProbe = defaultProbe) {
  const checks: PreflightCheck[] = [];
  const add = (id: string, status: PreflightCheck["status"], message: string) => checks.push({ id, status, message });
  if (inventory.host.platform === "linux" && inventory.host.architecture === "x64") add("platform", "passed", "Linux x86_64 matches the published build profiles.");
  else add("platform", "failed", "Managed GPU images currently require Linux x86_64. Other hosts can connect an external worker.");
  if (inventory.host.container.detected) add("host-access", "failed", "Run the installer on the GPU host, outside the web application's container.");
  else add("host-access", "passed", "The current process is not known to be inside a container.");
  let engineReady = false;
  try {
    await probe.command(engine, ["version", "--format", "{{json .}}"]);
    await probe.command(engine, ["info", "--format", "{{json .}}"]);
    engineReady = true;
    add("container-engine", "passed", `${engine} is installed and its engine is accessible.`);
  } catch { add("container-engine", "failed", `${engine} is unavailable or the current account cannot access its engine.`); }
  if (inventory.gpus.some((gpu) => gpu.vendor === "nvidia") && engineReady) {
    if (engine === "docker") {
      try {
        const runtimes = JSON.parse(await probe.command("docker", ["info", "--format", "{{json .Runtimes}}"]));
        add("nvidia-container-toolkit", Object.hasOwn(runtimes, "nvidia") ? "passed" : "failed", Object.hasOwn(runtimes, "nvidia") ? "Docker has the NVIDIA runtime needed by --gpus." : "Configure NVIDIA Container Toolkit for Docker before starting CUDA workers.");
      } catch { add("nvidia-container-toolkit", "failed", "Could not confirm Docker's NVIDIA runtime configuration."); }
    } else {
      try {
        const devices = await probe.command("nvidia-ctk", ["cdi", "list"]);
        const allPresent = inventory.gpus.filter((gpu) => gpu.vendor === "nvidia").every((gpu) => gpu.uuid && devices.includes(`nvidia.com/gpu=${gpu.uuid}`));
        add("nvidia-cdi", allPresent ? "passed" : "failed", allPresent ? "NVIDIA CDI entries are present for the selected GPUs." : "Refresh NVIDIA Container Toolkit CDI entries for the detected GPU UUIDs.");
      } catch { add("nvidia-cdi", "failed", "NVIDIA Container Toolkit CDI entries are unavailable to Podman."); }
    }
    const driversReady = inventory.gpus.filter((gpu) => gpu.vendor === "nvidia").every((gpu) => meetsCudaProfileDriverMinimum(gpu.driverVersion));
    add("nvidia-driver", driversReady ? "passed" : "failed", "This managed CUDA 12.8.1 profile requires Linux NVIDIA driver 570.124.06 or newer as a conservative baseline. Older-driver compatibility modes are not qualified; GPU smoke tests still verify actual operations.");
  }
  let supplementalGroupIds: number[] = [];
  if (inventory.gpus.some((gpu) => gpu.vendor === "amd")) {
    try { supplementalGroupIds = await probe.deviceGroups(); add("amd-devices", "passed", "AMD compute and render devices are visible; numeric device group IDs were collected."); }
    catch { add("amd-devices", "failed", "AMD workers need readable /dev/kfd and /dev/dri device nodes on the host."); }
    if (engine === "podman") {
      try { await probe.command("crun", ["--version"]); add("amd-rootless-groups", "passed", "crun is available for preserving rootless device-group access."); }
      catch { add("amd-rootless-groups", "failed", "Rootless AMD Podman workers require crun to preserve supplemental device groups."); }
    }
  }
  if (!inventory.gpus.length) add("visible-gpu", "failed", "No usable GPU inventory is visible; inspect the hardware diagnostics before installation.");
  return { ready: checks.every((check) => check.status !== "failed"), checks, supplementalGroupIds };
}

export type RuntimePreflight = Awaited<ReturnType<typeof inspectRuntimePrerequisites>>;
export type ContainerEngineChoice = ContainerEngine | "auto";

/** Probe the complete GPU prerequisites, not just whether an engine binary exists. */
export async function selectRuntimeEngine(inventory: HardwareInventory, choice: ContainerEngineChoice = "auto", inspect = inspectRuntimePrerequisites): Promise<{ engine: ContainerEngine; preflight: RuntimePreflight }> {
  if (choice !== "auto") return { engine: choice, preflight: await inspect(inventory, choice) };
  const candidates = await Promise.all((["podman", "docker"] as const).map(async (engine) => ({ engine, preflight: await inspect(inventory, engine) })));
  const ready = candidates.find((candidate) => candidate.preflight.ready);
  if (ready) return ready;
  const best = candidates.find((candidate) => candidate.preflight.checks.some((check) => check.id === "container-engine" && check.status === "passed")) ?? candidates[0];
  return { engine: best.engine, preflight: { ready: false, supplementalGroupIds: best.preflight.supplementalGroupIds,
    checks: [{ id: "automatic-engine", status: "failed", message: "Neither Podman nor Docker is ready for the selected GPUs. Resolve the prerequisites for either engine, or connect an external worker." },
      ...candidates.flatMap(({ engine, preflight }) => preflight.checks.map((check) => ({ ...check, id: `${engine}:${check.id}`, message: `${engine}: ${check.message}` })))],
  } };
}

export function loadRuntimeEnvironment() {
  try { process.loadEnvFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function main() {
  loadRuntimeEnvironment();
  const args = process.argv.slice(2);
  let choice: ContainerEngineChoice = "auto";
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--json") continue;
    if (args[index] === "--podman") { choice = "podman"; continue; }
    if (args[index] === "--engine" && ["auto", "docker", "podman"].includes(args[index + 1])) { choice = args[++index] as ContainerEngineChoice; continue; }
    throw new Error("Usage: pnpm doctor [--engine auto|docker|podman] [--json]");
  }
  const hardware = await detectHardware();
  const { engine, preflight: result } = await selectRuntimeEngine(hardware, choice);
  if (args.includes("--json")) console.log(JSON.stringify({ hardware, engine, ...result }, null, 2));
  else {
    console.log(`Gravity runtime preflight · ${engine}`);
    for (const check of result.checks) console.log(`${check.status.toUpperCase()}: ${check.message}`);
    for (const diagnostic of hardware.diagnostics) console.log(`${diagnostic.severity.toUpperCase()}: ${diagnostic.message}`);
  }
  if (!result.ready) process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch((error) => { console.error(error instanceof Error ? error.message : "Runtime preflight failed."); process.exitCode = 1; });
