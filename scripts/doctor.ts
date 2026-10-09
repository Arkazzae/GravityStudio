import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { detectHardware } from "../packages/hardware/src/index.ts";
import type { HardwareInventory } from "../packages/hardware/src/index.ts";
import type { ContainerEngine } from "./runtime-plan.ts";

const execute = promisify(execFile);
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
    const drivers = inventory.gpus.filter((gpu) => gpu.vendor === "nvidia").map((gpu) => Number(gpu.driverVersion?.split(".")[0]));
    add("nvidia-driver", drivers.every((major) => Number.isFinite(major) && major >= 570) ? "passed" : "warning", "The CUDA 12.8 profile targets driver 570 or newer; the GPU smoke test verifies actual operations.");
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

async function main() {
  const args = process.argv.slice(2);
  const engine = args.includes("--podman") ? "podman" : "docker";
  if (args.some((arg) => !["--podman", "--json"].includes(arg))) throw new Error("Usage: pnpm doctor [--podman] [--json]");
  const hardware = await detectHardware();
  const result = await inspectRuntimePrerequisites(hardware, engine);
  if (args.includes("--json")) console.log(JSON.stringify({ hardware, engine, ...result }, null, 2));
  else {
    console.log(`Gravity runtime preflight · ${engine}`);
    for (const check of result.checks) console.log(`${check.status.toUpperCase()}: ${check.message}`);
    for (const diagnostic of hardware.diagnostics) console.log(`${diagnostic.severity.toUpperCase()}: ${diagnostic.message}`);
  }
  if (!result.ready) process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch((error) => { console.error(error instanceof Error ? error.message : "Runtime preflight failed."); process.exitCode = 1; });
