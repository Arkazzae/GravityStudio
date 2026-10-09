import type { GpuDevice, HardwareInventory, HardwareProbe } from "../../packages/hardware/src/index.ts";

export const GIB = 1024 ** 3;
export const NOW = new Date("2026-01-01T12:00:00.000Z");
export function gpu(id: string, vendor: "nvidia" | "amd", memoryGiB: number, architecture: string | null = null): GpuDevice {
  return { id, vendor, name: id, architecture, uuid: id.split(":").at(-1)!, pciAddress: null,
    memory: { totalBytes: memoryGiB * GIB, usedBytes: 0 }, driverVersion: vendor === "amd" ? "amdgpu-test" : "nvidia-test" };
}
export function inventory(gpus: GpuDevice[], ramGiB = 96): HardwareInventory {
  return { schemaVersion: 1, detectedAt: NOW.toISOString(), host: { platform: "linux", architecture: "x64", logicalCpuCount: 16,
    memory: { totalBytes: ramGiB * GIB, availableBytes: ramGiB * GIB }, container: { detected: false, markers: [] } }, gpus, diagnostics: [] };
}
export const dualR9700 = () => inventory([gpu("amd:9700a", "amd", 32, "gfx1201"), gpu("amd:9700b", "amd", 32, "gfx1201")]);
export const triple3090 = () => inventory([1, 2, 3].map((index) => gpu(`nvidia:GPU-3090-${index}`, "nvidia", 24, "sm_86")));
export const singleB100 = () => inventory([gpu("nvidia:GPU-b100", "nvidia", 192, "sm_100")], 512);

export function fakeProbe(options: { files?: Record<string, string>; directories?: Record<string, string[]>; paths?: Record<string, string>; commands?: Record<string, string>; platform?: string } = {}) {
  const calls: { file: string; args: string[]; timeoutMs: number; maxOutputBytes: number }[] = [];
  const missing = () => Object.assign(new Error("Fixture not available"), { code: "ENOENT" });
  const probe: HardwareProbe = {
    platform: options.platform ?? "linux", architecture: "x64", logicalCpuCount: 16, totalMemoryBytes: 96 * GIB, freeMemoryBytes: 80 * GIB,
    async readFile(path) { if (!(path in (options.files ?? {}))) throw missing(); return options.files![path]; },
    async readDirectory(path) { if (!(path in (options.directories ?? {}))) throw missing(); return options.directories![path]; },
    async realpath(path) { if (!(path in (options.paths ?? {}))) throw missing(); return options.paths![path]; },
    async command(file, args, limits) {
      calls.push({ file, args, ...limits });
      const command = `${file} ${args.join(" ")}`;
      if (!(command in (options.commands ?? {}))) throw missing();
      return options.commands![command];
    },
  };
  return { probe, calls };
}

export const nvidiaQuery = "nvidia-smi --query-gpu=uuid,name,pci.bus_id,memory.total,memory.used,driver_version,compute_cap --format=csv,noheader,nounits";
