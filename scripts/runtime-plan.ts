import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assessRuntimeCompatibility } from "../packages/hardware/src/index.ts";
import type { Diagnostic, GpuDevice, HardwareInventory, RuntimeProfile } from "../packages/hardware/src/index.ts";
import type { WorkerSettings } from "../packages/contracts/index.ts";
import lock from "../deploy/comfyui/runtime.lock.json" with { type: "json" };

export type ContainerEngine = "docker" | "podman";
export interface RuntimeCommand { program: ContainerEngine; args: string[] }
export interface ManagedWorker {
  id: string;
  containerName: string;
  gpuId: string;
  backend: "cuda" | "rocm";
  runtimeProfileId: string;
  runtimeRevision: string;
  deploymentHash: string;
  image: string;
  baseUrl: string;
  stateDirectory: string;
  create: RuntimeCommand;
  start: RuntimeCommand;
  smoke: RuntimeCommand;
}
export interface RuntimeDeployment {
  version: 1;
  engine: ContainerEngine;
  dataDirectory: string;
  modelsDirectory: string;
  composeFile: string;
  compose: { name: string; services: Record<string, Record<string, unknown>> };
  build: RuntimeCommand[];
  workers: ManagedWorker[];
  diagnostics: Diagnostic[];
}
export interface RuntimeDeploymentOptions {
  engine?: ContainerEngine;
  dataDirectory: string;
  repoDirectory?: string;
  gpuIds?: readonly string[];
  portBase?: number;
  reserveVramGiB?: number;
  userId?: number;
  groupId?: number;
  supplementalGroupIds?: readonly number[];
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD_FILES = ["Containerfile", "fetch_source.py", "bootstrap.py", "smoke.py", "requirements.lock"];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function managedRuntimeProfiles(repoDirectory = ROOT): RuntimeProfile[] {
  const root = join(repoDirectory, "deploy/comfyui");
  const files = BUILD_FILES.map((name) => `${name}\0${readFileSync(join(root, name), "utf8")}`).join("\0");
  return Object.entries(lock.profiles).map(([backend, profile]) => ({ id: profile.id, backend: backend as "cuda" | "rocm", architectures: profile.architectures,
    revision: digest(JSON.stringify({ platform: lock.platform, comfyui: lock.comfyui, profile }) + files) }));
}

function safePath(path: string) {
  if (!isAbsolute(path) || /[\0\r\n,]/.test(path)) throw new TypeError("Runtime paths must be absolute and contain no control characters or commas.");
  return resolve(path);
}
const composePath = (path: string) => path.replaceAll("$", () => "$$");
function deviceSelector(gpu: GpuDevice): string | null {
  if (gpu.vendor === "nvidia") return gpu.uuid && /^GPU-[a-z\d-]+$/i.test(gpu.uuid) ? gpu.uuid : null;
  if (!gpu.uuid || !/^(?:GPU-)?[a-f\d]{1,16}$/i.test(gpu.uuid)) return null;
  return `GPU-${gpu.uuid.replace(/^GPU-/i, "").padStart(16, "0")}`;
}

/** Build a reviewable plan without touching files, containers or the network. */
export function createRuntimeDeployment(inventory: HardwareInventory, options: RuntimeDeploymentOptions): RuntimeDeployment {
  const engine = options.engine ?? "docker";
  if (engine !== "docker" && engine !== "podman") throw new TypeError("Choose Docker or Podman.");
  const dataDirectory = safePath(options.dataDirectory), repoDirectory = safePath(options.repoDirectory ?? ROOT);
  const modelsDirectory = join(dataDirectory, "models"), composeFile = join(dataDirectory, "runtime", "compose.json");
  const profiles = managedRuntimeProfiles(repoDirectory);
  const portBase = options.portBase ?? 8188, reserveGiB = options.reserveVramGiB ?? 2;
  const uid = options.userId ?? process.getuid?.() ?? 1000, gid = options.groupId ?? process.getgid?.() ?? 1000;
  if (![uid, gid, ...(options.supplementalGroupIds ?? [])].every((id) => Number.isSafeInteger(id) && id >= 0)) throw new TypeError("User and group IDs must be nonnegative integers.");
  if (!Number.isInteger(portBase) || portBase < 1024 || portBase > 65535 || !Number.isFinite(reserveGiB) || reserveGiB < 0) throw new TypeError("Invalid runtime port or VRAM reserve.");
  const diagnostics: Diagnostic[] = [];
  if (inventory.host.platform !== "linux" || inventory.host.architecture !== "x64") diagnostics.push({ code: "unsupported-host", severity: "error", message: "Managed images currently target Linux x86_64. Connect an external worker on other hosts." });
  if (inventory.host.container.detected) diagnostics.push({ code: "nested-runtime", severity: "error", message: "Run the managed-runtime installer directly on the GPU host. The web container does not need the host container socket." });
  const ids = options.gpuIds ?? inventory.gpus.map((gpu) => gpu.id);
  if (new Set(ids).size !== ids.length) diagnostics.push({ code: "duplicate-gpu", severity: "error", message: "GPU selections must be unique." });
  for (const id of ids) if (!inventory.gpus.some((gpu) => gpu.id === id)) diagnostics.push({ code: "unknown-gpu", severity: "error", source: id, message: "The selected GPU is no longer visible." });
  const selected = inventory.gpus.filter((gpu) => ids.includes(gpu.id)).sort((a, b) => a.id.localeCompare(b.id));
  if (!selected.length) diagnostics.push({ code: "no-gpu", severity: "error", message: "Select at least one detected GPU before starting a managed worker." });
  const workers: ManagedWorker[] = [], build: RuntimeCommand[] = [], services: Record<string, Record<string, unknown>> = {};
  const built = new Set<string>();
  for (const [index, gpu] of selected.entries()) {
    const backend = gpu.vendor === "nvidia" ? "cuda" : "rocm", profile = profiles.find((item) => item.backend === backend)!;
    const pinned = lock.profiles[backend], selector = deviceSelector(gpu), port = portBase + index;
    if (port > 65535) throw new TypeError("The selected worker ports exceed 65535.");
    if (!selector) {
      diagnostics.push({ code: "gpu-uuid-required", severity: "error", source: gpu.id, message: "A persistent GPU UUID is needed to start this worker safely. Fix device visibility or configure an external worker." });
      continue;
    }
    const compatibility = assessRuntimeCompatibility(gpu, profile);
    if (compatibility.status === "incompatible") diagnostics.push({ code: "unsupported-architecture", severity: "error", source: gpu.id, message: compatibility.reason });
    else diagnostics.push({ code: "runtime-needs-smoke-test", severity: "info", source: gpu.id, message: "This is a candidate runtime. Run its GPU smoke test before model validation." });
    if (gpu.memory.totalBytes <= reserveGiB * 1024 ** 3) diagnostics.push({ code: "insufficient-vram", severity: "error", source: gpu.id, message: "The selected VRAM reserve leaves no capacity for model execution." });
    const suffix = digest(gpu.id).slice(0, 12), name = `gravity-comfy-${backend}-${suffix}`;
    const stateDirectory = join(dataDirectory, "workers", name), image = `localhost/gravity-comfy-${backend}:${profile.revision.slice(0, 16)}`;
    const buildArgs = { BASE_IMAGE: pinned.baseImage, COMFY_COMMIT: lock.comfyui.commit, COMFY_ARCHIVE_SHA256: lock.comfyui.archiveSha256, RUNTIME_REVISION: profile.revision, RUNTIME_PROFILE_ID: profile.id };
    if (!built.has(backend)) {
      build.push({ program: engine, args: ["build", "--platform", lock.platform, "--file", join(repoDirectory, "deploy/comfyui/Containerfile"), "--tag", image,
        ...Object.entries(buildArgs).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]), join(repoDirectory, "deploy/comfyui")] });
      built.add(backend);
    }
    const environment: Record<string, string> = { GRAVITY_RESERVE_VRAM_GIB: String(reserveGiB) };
    const deviceArgs: string[] = [], groups: string[] = [];
    const gpuCompose: Record<string, unknown> = {};
    if (backend === "cuda") {
      if (engine === "docker") {
        deviceArgs.push("--gpus", `device=${selector}`);
        gpuCompose.deploy = { resources: { reservations: { devices: [{ driver: "nvidia", device_ids: [selector], capabilities: ["gpu"] }] } } };
      } else {
        deviceArgs.push("--device", `nvidia.com/gpu=${selector}`);
        gpuCompose.devices = [`nvidia.com/gpu=${selector}`];
      }
    } else {
      deviceArgs.push("--device", "/dev/kfd", "--device", "/dev/dri");
      environment.ROCR_VISIBLE_DEVICES = selector;
      gpuCompose.devices = ["/dev/kfd:/dev/kfd", "/dev/dri:/dev/dri"];
      if (engine === "podman") {
        deviceArgs.push("--runtime", "crun");
        groups.push("keep-groups");
        gpuCompose.runtime = "crun";
      } else groups.push(...new Set((options.supplementalGroupIds ?? []).map(String)));
      if (engine === "docker" && !groups.length) diagnostics.push({ code: "amd-device-groups", severity: "warning", source: gpu.id, message: "The installer will inspect AMD device group IDs before startup; Docker workers need those numeric supplemental groups." });
      diagnostics.push({ code: "amd-placement", severity: "info", source: gpu.id, message: "ROCR_VISIBLE_DEVICES selects this GPU. Exposing /dev/dri is runtime placement, not isolation from untrusted code." });
    }
    const labels = { "io.gravity.owner": "gravity-studio", "io.gravity.runtime.revision": profile.revision };
    const args = ["create", "--name", name, "--restart", "unless-stopped", ...(engine === "podman" ? ["--userns", "keep-id"] : []), "--user", `${uid}:${gid}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--shm-size", "2g", "--stop-signal", "SIGINT", "--stop-timeout", "30",
      "--publish", `127.0.0.1:${port}:8188`, "--mount", `type=bind,src=${modelsDirectory},dst=/models,readonly`, "--mount", `type=bind,src=${stateDirectory},dst=/data`,
      ...deviceArgs, ...groups.flatMap((group) => ["--group-add", group]), ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]), ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]), image];
    const deploymentHash = digest(JSON.stringify(args));
    args.splice(args.length - 1, 0, "--label", `io.gravity.deployment=${deploymentHash}`);
    workers.push({ id: name, containerName: name, gpuId: gpu.id, backend, runtimeProfileId: profile.id, runtimeRevision: profile.revision, deploymentHash, image, baseUrl: `http://127.0.0.1:${port}`, stateDirectory,
      create: { program: engine, args }, start: { program: engine, args: ["start", name] }, smoke: { program: engine, args: ["exec", name, "python3", "/opt/gravity/smoke.py"] } });
    services[name] = { image, build: { context: composePath(join(repoDirectory, "deploy/comfyui")), dockerfile: "Containerfile", args: buildArgs }, platform: lock.platform,
      container_name: name, restart: "unless-stopped", user: `${uid}:${gid}`, ...(engine === "podman" ? { userns_mode: "keep-id" } : {}), cap_drop: ["ALL"], security_opt: ["no-new-privileges"], shm_size: "2gb", stop_signal: "SIGINT", stop_grace_period: "30s",
      ports: [`127.0.0.1:${port}:8188`], volumes: [{ type: "bind", source: composePath(modelsDirectory), target: "/models", read_only: true }, { type: "bind", source: composePath(stateDirectory), target: "/data" }],
      environment, labels: { ...labels, "io.gravity.deployment": deploymentHash }, ...(groups.length ? { group_add: groups } : {}), ...gpuCompose };
  }
  return { version: 1, engine, dataDirectory, modelsDirectory, composeFile, compose: { name: "gravity-runtime", services }, build, workers, diagnostics };
}

/** Display only; execution always uses argv arrays with execFile/spawn. */
export function formatRuntimeCommand(command: RuntimeCommand): string {
  return [command.program, ...command.args].map((arg) => /^[a-z\d_./:=@,-]+$/i.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}

/** A settings proposal only: importing it must preserve the user's other settings. */
export function runtimeWorkerSettings(plan: RuntimeDeployment): WorkerSettings[] {
  return plan.workers.map((worker, index) => ({ id: worker.id, name: `Image worker ${index + 1} · ${worker.backend.toUpperCase()}`, baseUrl: worker.baseUrl,
    deviceIds: [worker.gpuId], enabled: false, location: "local", maxConcurrentJobs: 1 }));
}
