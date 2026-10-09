import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { GpuDevice, HardwareInventory } from "../packages/hardware/src/index.ts";
import { inspectRuntimePrerequisites, selectRuntimeEngine } from "./doctor.ts";
import { runtimePortAvailable } from "./runtime-auto.ts";
import { executeRuntimeCommand } from "./runtime-control.ts";
import type { RuntimeRunner } from "./runtime-control.ts";
import type { ContainerEngine } from "./runtime-plan.ts";
import lock from "../deploy/llamacpp/runtime.lock.json" with { type: "json" };

const MODEL_ID = "mimo-v2.6-distill-qwen-9b";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const backend = (gpu: GpuDevice) => gpu.vendor === "amd" ? "rocm" : "cuda";
function selector(gpu: GpuDevice): string | null {
  if (gpu.vendor === "nvidia") return gpu.uuid && /^GPU-[a-z\d-]+$/i.test(gpu.uuid) ? gpu.uuid : null;
  if (!gpu.uuid || !/^(?:GPU-)?[a-f\d]{1,16}$/i.test(gpu.uuid)) return null;
  return `GPU-${gpu.uuid.replace(/^GPU-/i, "").padStart(16, "0")}`;
}
export function localTextGpuSupport(gpu: GpuDevice): { supported: boolean; reason?: string } {
  if (!selector(gpu)) return { supported: false, reason: "A stable GPU UUID is required for the local text runtime." };
  if (!gpu.architecture || !(lock.profiles[backend(gpu)].architectures as readonly string[]).includes(gpu.architecture)) {
    return { supported: false, reason: "This GPU architecture is outside the pinned llama.cpp build profile." };
  }
  return { supported: true };
}

/** The pinned loader prints allocated model buffers rounded to two decimals.
 * Credit a lower bound of that allocation only, never KV/compute or a global
 * device-memory delta. Ambiguous, partial or multi-device loads get no credit. */
export function textModelAllocation(logs: string, deviceBackend: "rocm" | "cuda"): number {
  const offloads = [...logs.matchAll(/offloaded (\d+)\/(\d+) layers to GPU/g)];
  if (offloads.length !== 1 || Number(offloads[0][1]) <= 0 || offloads[0][1] !== offloads[0][2]) return 0;
  const buffers = [...logs.matchAll(/\b(ROCm|CUDA)(\d+)\s+model buffer size\s*=\s*(\d+\.\d{2}) MiB/g)];
  if (buffers.length !== 1 || buffers[0][1] !== (deviceBackend === "rocm" ? "ROCm" : "CUDA") || buffers[0][2] !== "0") return 0;
  const bytes = Math.floor((Number(buffers[0][3]) - 0.01) * 1024 ** 2);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
}

interface SavedPlan {
  version: 1;
  engine: ContainerEngine;
  containerName: string;
  workspace: string;
  planHash: string;
  gpuId: string;
  image: string;
  port: number;
}
interface ContainerInfo {
  Id: string;
  Image: string;
  State: { Running: boolean; Status?: string };
  Config: { Labels: Record<string, string> };
}
export interface TextRuntimeStatus { running: boolean; containerId: string | null; gpuId: string | null; baseUrl: string | null }
export interface StartedTextRuntime { baseUrl: string; modelId: string; apiKey: string; containerId: string; allocatedVramBytes: number }
export interface TextRuntimeOptions {
  run?: RuntimeRunner;
  inspectPrerequisites?: typeof inspectRuntimePrerequisites;
  fetch?: typeof fetch;
  portAvailable?: typeof runtimePortAvailable;
  port?: number;
  healthTimeoutMs?: number;
  onProgress?: (message: string) => void;
}
function safePath(value: string): string {
  if (!isAbsolute(value) || /[\0\r\n,]/.test(value)) throw new Error("Runtime paths must be absolute and contain no control characters or commas.");
  return resolve(value);
}

/** One owned, non-restarting container. The caller must hold a GPU lease from
 * start until stop succeeds, including cancellation and failed startup. */
export class ManagedTextContainer {
  readonly #dataDirectory: string;
  readonly #workspace: string;
  readonly #name: string;
  readonly #directory: string;
  readonly #planPath: string;
  readonly #run: RuntimeRunner;
  readonly #options: TextRuntimeOptions;
  #queue: Promise<unknown> = Promise.resolve();
  #prepared = new Map<string, { engine: ContainerEngine; groups: number[]; imageId: string }>();

  constructor(dataDirectory: string, options: TextRuntimeOptions = {}) {
    this.#dataDirectory = safePath(dataDirectory);
    this.#workspace = hash(this.#dataDirectory);
    this.#name = `gravity-text-${this.#workspace.slice(0, 12)}`;
    this.#directory = join(this.#dataDirectory, "runtime", "text");
    this.#planPath = join(this.#directory, "plan.json");
    this.#run = options.run ?? executeRuntimeCommand;
    this.#options = options;
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535)) throw new Error("Invalid local text runtime port.");
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#queue.then(operation);
    this.#queue = pending.catch(() => undefined);
    return pending;
  }

  async #readPlan(): Promise<SavedPlan | null> {
    let value: SavedPlan;
    try { value = JSON.parse(await readFile(this.#planPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (value.version !== 1 || !["docker", "podman"].includes(value.engine) || value.workspace !== this.#workspace || value.containerName !== this.#name ||
      !/^[a-f\d]{64}$/.test(value.planHash) || typeof value.gpuId !== "string" || !/^ghcr\.io\/ggml-org\/llama\.cpp@sha256:[a-f\d]{64}$/.test(value.image) ||
      !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) throw new Error("Invalid saved local text runtime plan; no containers were changed.");
    return value;
  }

  async #writePlan(plan: SavedPlan) {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#planPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, this.#planPath);
  }

  async #existing(plan: SavedPlan): Promise<ContainerInfo | null> {
    // A failing engine query is not proof that the old process has stopped.
    const listed = await this.#run({ program: plan.engine, args: ["container", "ls", "--all", "--format", "{{.Names}}"] });
    if (!listed.stdout.split(/\r?\n/).some(name => name.trim() === plan.containerName)) return null;
    const { stdout } = await this.#run({ program: plan.engine, args: ["container", "inspect", "--format", "{{json .}}", plan.containerName] });
    const info = JSON.parse(stdout) as ContainerInfo;
    this.#assertOwned(plan, info);
    return info;
  }

  #assertOwned(plan: SavedPlan, info: ContainerInfo) {
    if (!/^[a-f\d]{64}$/.test(info.Id) || typeof info.State?.Running !== "boolean" ||
      info.Config?.Labels?.["io.gravity.owner"] !== "gravity-studio" || info.Config.Labels["io.gravity.role"] !== "text" ||
      info.Config.Labels["io.gravity.text.workspace"] !== this.#workspace || info.Config.Labels["io.gravity.text.plan"] !== plan.planHash) {
      throw new Error("An existing container does not belong to this local text runtime plan; it was left untouched.");
    }
  }

  async #stop() {
    const plan = await this.#readPlan();
    if (!plan) return;
    const info = await this.#existing(plan);
    if (!info) return;
    // Address the inspected immutable ID, never a name which could be replaced.
    if (info.State.Running) await this.#run({ program: plan.engine, args: ["container", "stop", "--time", "20", info.Id] }, { timeoutMs: 30_000 });
    const { stdout } = await this.#run({ program: plan.engine, args: ["container", "inspect", "--format", "{{json .}}", info.Id] });
    const stopped = JSON.parse(stdout) as ContainerInfo;
    this.#assertOwned(plan, stopped);
    if (stopped.Id !== info.Id || stopped.State.Running || stopped.State.Status === "restarting") throw new Error("The local text runtime has not stopped; keep its GPU reserved.");
    // Removing the stopped process releases its device handles and prevents reuse
    // with an old GPU or model path. No --force and no volumes are removed.
    await this.#run({ program: plan.engine, args: ["container", "rm", info.Id] });
  }

  stop(): Promise<void> { return this.#exclusive(() => this.#stop()); }
  recover(): Promise<void> { return this.stop(); }
  close(): Promise<void> { return this.stop(); }
  status(): Promise<TextRuntimeStatus> { return this.#exclusive(async () => {
    const plan = await this.#readPlan();
    if (!plan) return { running: false, containerId: null, gpuId: null, baseUrl: null };
    const info = await this.#existing(plan);
    return { running: info?.State.Running ?? false, containerId: info?.Id ?? null, gpuId: plan.gpuId, baseUrl: `http://127.0.0.1:${plan.port}/v1` };
  }); }

  #gpuKey(gpu: GpuDevice) { return hash({ id: gpu.id, uuid: gpu.uuid, architecture: gpu.architecture, driver: gpu.driverVersion }); }

  #validateGpu(gpu: GpuDevice, inventory: HardwareInventory) {
    const supported = localTextGpuSupport(gpu);
    if (!supported.supported) throw new Error(supported.reason);
    const detected = inventory.gpus.find(item => item.id === gpu.id);
    if (!detected || this.#gpuKey(detected) !== this.#gpuKey(gpu)) throw new Error("The selected local text GPU is no longer present in the current inventory.");
  }

  async #prepare(gpu: GpuDevice, inventory: HardwareInventory, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.#validateGpu(gpu, inventory);
    const saved = await this.#readPlan();
    const result = await selectRuntimeEngine({ ...inventory, gpus: [gpu] }, saved?.engine ?? "auto", this.#options.inspectPrerequisites ?? inspectRuntimePrerequisites);
    if (!result.preflight.ready) throw new Error(result.preflight.checks.filter(check => check.status === "failed").map(check => check.message).join(" "));
    signal?.throwIfAborted();
    const image = lock.profiles[backend(gpu)].image;
    const { stdout } = await this.#run({ program: result.engine, args: ["image", "ls", "--quiet", image] }, { signal });
    if (!stdout.trim()) {
      this.#options.onProgress?.(`Downloading the pinned llama.cpp ${backend(gpu).toUpperCase()} runtime image.`);
      await this.#run({ program: result.engine, args: ["pull", "--platform", lock.platform, image] }, { signal, timeoutMs: 45 * 60_000, stream: true });
    }
    const inspected = await this.#run({ program: result.engine, args: ["image", "inspect", "--format", "{{json .}}", image] }, { signal });
    const info = JSON.parse(inspected.stdout) as { Id?: string; Architecture?: string; Os?: string; RepoDigests?: string[]; Config?: { Labels?: Record<string, string> } };
    if (!info.Id || !/^(?:sha256:)?[a-f\d]{64}$/.test(info.Id) || info.Architecture !== "amd64" || info.Os !== "linux" ||
      !info.RepoDigests?.includes(image) || info.Config?.Labels?.["org.opencontainers.image.revision"] !== lock.revision) throw new Error("The local text runtime image does not match its pinned digest, architecture and source revision.");
    this.#prepared.set(this.#gpuKey(gpu), { engine: result.engine, groups: result.preflight.supplementalGroupIds, imageId: `sha256:${info.Id.replace(/^sha256:/, "")}` });
  }

  prepare(gpu: GpuDevice, inventory: HardwareInventory, signal?: AbortSignal): Promise<void> {
    return this.#exclusive(() => this.#prepare(gpu, inventory, signal));
  }

  async #apiKey(): Promise<{ path: string; value: string }> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const path = join(this.#directory, "api-key");
    try { await writeFile(path, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid local text runtime key file.");
    await chmod(path, 0o600);
    const value = (await readFile(path, "utf8")).trim();
    if (!/^[a-f\d]{64}$/.test(value)) throw new Error("Invalid local text runtime key file.");
    return { path, value };
  }

  start(gpu: GpuDevice, inventory: HardwareInventory, modelPath: string, signal?: AbortSignal): Promise<StartedTextRuntime> {
    return this.#exclusive(async () => {
      signal?.throwIfAborted();
      this.#validateGpu(gpu, inventory);
      if (!this.#prepared.has(this.#gpuKey(gpu))) await this.#prepare(gpu, inventory, signal);
      const prepared = this.#prepared.get(this.#gpuKey(gpu))!;
      const path = safePath(await realpath(safePath(modelPath)));
      const dataRoot = await realpath(this.#dataDirectory);
      if (!path.startsWith(`${dataRoot}${sep}`) || !(await lstat(path)).isFile()) throw new Error("The local text model must be a regular file inside the application data directory.");
      const old = await this.#readPlan();
      if (old && (await this.#existing(old))?.State.Running) throw new Error("The local text runtime is already running. Stop it before changing its GPU or model.");
      await this.#stop();
      signal?.throwIfAborted();
      const available = this.#options.portAvailable ?? runtimePortAvailable;
      let port = this.#options.port ?? old?.port ?? 18401;
      const last = this.#options.port === undefined ? Math.min(port + 99, 65535) : port;
      while (port <= last && !await available(port)) port++;
      if (port > last) throw new Error("No free loopback port is available for the local text runtime.");
      const key = await this.#apiKey();
      const uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000;
      const args = ["create", "--name", this.#name, "--platform", lock.platform, "--restart", "no", "--user", `${uid}:${gid}`,
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456",
        "--shm-size", "256m", "--stop-signal", "SIGTERM", "--stop-timeout", "20", "--publish", `127.0.0.1:${port}:8080`,
        "--mount", `type=bind,src=${path},dst=/models/model.gguf,readonly`, "--mount", `type=bind,src=${key.path},dst=/run/gravity/api-key,readonly`,
        "--env", "HOME=/tmp"];
      if (prepared.engine === "podman") args.push("--userns", "keep-id");
      if (gpu.vendor === "amd") {
        args.push("--device", "/dev/kfd", "--device", "/dev/dri", "--env", `ROCR_VISIBLE_DEVICES=${selector(gpu)}`);
        if (prepared.engine === "podman") args.push("--runtime", "crun", "--group-add", "keep-groups");
        else for (const group of prepared.groups) args.push("--group-add", String(group));
      } else if (prepared.engine === "docker") args.push("--gpus", `device=${selector(gpu)}`);
      else args.push("--device", `nvidia.com/gpu=${selector(gpu)}`);
      const serverArgs = ["--model", "/models/model.gguf", "--alias", MODEL_ID, "--host", "0.0.0.0", "--port", "8080",
        "--api-key-file", "/run/gravity/api-key", "--ctx-size", "8192", "--parallel", "1", "--n-gpu-layers", "999", "--split-mode", "none", "--fit", "off",
        "--jinja", "--chat-template-kwargs", '{"enable_thinking":false}', "--reasoning", "off", "--reasoning-format", "deepseek", "--no-mmproj", "--no-webui",
        "--sleep-idle-seconds", "-1", "--no-context-shift",
        // This pin maps backend allocation INFO to trace (4). Debug (5) also
        // prints request bodies and prompt tokens, so never enable --verbose.
        "--log-verbosity", "4"];
      const image = lock.profiles[backend(gpu)].image;
      const plan: SavedPlan = { version: 1, engine: prepared.engine, containerName: this.#name, workspace: this.#workspace,
        planHash: hash({ args, serverArgs, image, imageId: prepared.imageId }), gpuId: gpu.id, image, port };
      args.push("--label", "io.gravity.owner=gravity-studio", "--label", "io.gravity.role=text", "--label", `io.gravity.text.workspace=${this.#workspace}`,
        "--label", `io.gravity.text.plan=${plan.planHash}`, image, ...serverArgs);
      // Persist before create: a crash at any subsequent instruction is recoverable.
      await this.#writePlan(plan);
      try {
        signal?.throwIfAborted();
        this.#options.onProgress?.("Loading MiMo on the selected GPU.");
        await this.#run({ program: prepared.engine, args }, { signal });
        const created = await this.#existing(plan);
        if (!created || created.Image.replace(/^sha256:/, "") !== prepared.imageId.replace(/^sha256:/, "")) throw new Error("The local text container does not use the prepared immutable image.");
        await this.#run({ program: prepared.engine, args: ["container", "start", created.Id] }, { signal });
        const timeout = AbortSignal.timeout(this.#options.healthTimeoutMs ?? 120_000);
        const readySignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        while (true) {
          readySignal.throwIfAborted();
          const info = await this.#existing(plan);
          if (!info?.State.Running) throw new Error("The local text runtime exited while loading the model.");
          try {
            const response = await (this.#options.fetch ?? fetch)(`http://127.0.0.1:${port}/health`, {
              headers: { Authorization: `Bearer ${key.value}` }, redirect: "error", signal: AbortSignal.any([readySignal, AbortSignal.timeout(3000)]),
            });
            await response.body?.cancel();
            if (response.ok) break;
          } catch { readySignal.throwIfAborted(); }
          await delay(250, undefined, { signal: readySignal });
        }
        let allocatedVramBytes = 0;
        try {
          const logs = await this.#run({ program: prepared.engine, args: ["container", "logs", "--tail", "1000", created.Id] }, { signal });
          allocatedVramBytes = textModelAllocation(`${logs.stdout}\n${logs.stderr}`, backend(gpu));
        } catch { signal?.throwIfAborted(); }
        const ready = await this.#existing(plan);
        if (!ready?.State.Running || ready.Id !== created.Id) throw new Error("The local text runtime changed before it became ready.");
        signal?.throwIfAborted();
        return { baseUrl: `http://127.0.0.1:${port}/v1`, modelId: MODEL_ID, apiKey: key.value, containerId: created.Id, allocatedVramBytes };
      } catch (error) {
        try { await this.#stop(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "The local text runtime failed to start and could not be confirmed stopped. Keep its GPU reserved."); }
        throw error;
      }
    });
  }
}
