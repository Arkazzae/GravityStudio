import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Engine } from "../../../apps/server/engine.ts";
import { Store } from "../../../apps/server/store.ts";
import { settingsView } from "../../../apps/server/settings.ts";
import type { GenerationInput, WorkerSettings } from "../../../packages/contracts/index.ts";
import type { HardwareInventory } from "../../../packages/hardware/src/types.ts";
import { completed, fakeComfy } from "../../inference/fake-comfy.ts";

export const GiB = 1024 ** 3;
export async function until(predicate: () => boolean, label = "condition", timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(5);
  }
}

export function inventory(): HardwareInventory {
  return {
    schemaVersion: 1, detectedAt: new Date().toISOString(),
    host: { platform: "linux", architecture: "x64", logicalCpuCount: 16, memory: { totalBytes: 64 * GiB, availableBytes: 64 * GiB }, container: { detected: false, markers: [] } },
    gpus: [16, 24, 8].map((capacity, index) => ({ id: `gpu-${index}`, vendor: "nvidia", name: `GPU ${index}`, architecture: "sm_86", pciAddress: `0000:0${index}:00.0`, uuid: `fixture-${index}`, memory: { totalBytes: capacity * GiB, usedBytes: 0 }, driverVersion: "fixture" })), diagnostics: [],
  };
}

export async function engineFixture(options: { count?: number; location?: "local" | "remote"; maxConcurrent?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gravity-engine-"));
  const workers = await Promise.all(Array.from({ length: options.count ?? 1 }, () => fakeComfy()));
  const stats = workers.map((_, index) => ({ system: { ram_total: 64 * GiB, ram_free: 64 * GiB, comfyui_version: "fixture" }, devices: [{ name: `Remote GPU ${index}`, type: "cuda", index: 0, vram_total: 16 * GiB, vram_free: 16 * GiB }] }));
  workers.forEach((worker, index) => { worker.state.responseOverride = path => path === "/system_stats" ? { body: JSON.stringify(stats[index]) } : undefined; });
  const store = new Store(directory);
  const owner = store.createOwner("owner", "fixture-only-password-hash");
  const settings = settingsView(store);
  settings.policy = { ramReserveBytes: 2 * GiB, vramReserveBytes: GiB, maxConcurrentJobs: options.maxConcurrent ?? 3, idleUnloadSeconds: 0 };
  settings.workers = workers.map((worker, index): WorkerSettings => ({ id: `worker-${index}`, name: `Worker ${index}`, baseUrl: worker.url, enabled: true, location: options.location ?? "remote", deviceIds: [(options.location ?? "remote") === "local" ? `gpu-${index === 1 ? 2 : index}` : `remote-gpu-${index}`], maxConcurrentJobs: 1 }));
  const sdxl = settings.modelConfigurations.find(model => model.modelId === "sdxl-base")!;
  sdxl.enabled = true; sdxl.workerIds = settings.workers.map(worker => worker.id); sdxl.memory = { ramBytes: 8 * GiB, vramBytes: 6 * GiB, source: "estimate" };
  store.saveSettings(settings);
  const context = {
    directory, workers, stats, store, owner, hardware: inventory(), beforeDetect: undefined as (() => Promise<void>) | undefined,
    engine: undefined as unknown as Engine,
    async queue(input: Partial<GenerationInput> = {}, key: string = randomUUID()) {
      const previous = context.engine.ticking; context.engine.ticking = true;
      try { return await context.engine.submit(owner.id, { modelId: "sdxl-base", prompt: "A ceramic cup", seed: 42, ...input }, key); }
      finally { context.engine.ticking = previous; }
    },
    complete(index: number, promptId: string) {
      const worker = workers[index];
      const entry = [...worker.state.pending, ...worker.state.running].find(item => item[1] === promptId);
      worker.state.history[promptId] = completed(entry);
      worker.state.pending = worker.state.pending.filter(item => item[1] !== promptId);
      worker.state.running = worker.state.running.filter(item => item[1] !== promptId);
    },
    async restart() {
      await context.engine.stop(); context.store.close();
      context.store = new Store(directory); context.engine = makeEngine();
    },
    async close() {
      await context.engine.stop(); context.store.close();
      await Promise.all(workers.map(worker => worker.close())); await rm(directory, { recursive: true, force: true });
    },
  };
  function makeEngine() {
    return new Engine(context.store, { pollMs: 10, reconcileMs: 30, detect: async () => { await context.beforeDetect?.(); return { ...structuredClone(context.hardware), detectedAt: new Date().toISOString() }; } });
  }
  context.engine = makeEngine();
  return context;
}
