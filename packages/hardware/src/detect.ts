import { execFile } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import { arch, availableParallelism, freemem, platform, totalmem } from "node:os";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { Diagnostic, GpuDevice, HardwareInventory, HardwareProbe } from "./types.ts";

const execute = promisify(execFile);
const MIB = 1024 ** 2;
const commandOptions = { timeoutMs: 2500, maxOutputBytes: 1024 * 1024 };
const defaultProbe: HardwareProbe = {
  platform: platform(), architecture: arch(), logicalCpuCount: availableParallelism(),
  get totalMemoryBytes() { return totalmem(); },
  get freeMemoryBytes() { return freemem(); },
  readFile: (path) => readFile(path, "utf8"), readDirectory: readdir, realpath,
  async command(file, args, options) {
    const result = await execute(file, args, { timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes, encoding: "utf8", windowsHide: true });
    return result.stdout;
  },
};

function value(source: unknown): string | null {
  return typeof source === "string" && source.trim() && !/^(n\/a|unknown|not supported|\[not supported\])$/i.test(source.trim()) ? source.trim() : null;
}

function pciAddress(source: unknown): string | null {
  const text = value(source)?.toLowerCase();
  if (!text || !/^[a-f\d]{4,8}:[a-f\d]{2}:[a-f\d]{2}\.[0-7]$/.test(text)) return null;
  return text.replace(/^0000([a-f\d]{4}:)/, "$1");
}

function csvRow(line: string): string[] {
  const values: string[] = [];
  let field = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { values.push(field.trim()); field = ""; }
    else field += char;
  }
  if (quoted) throw new Error("Unclosed CSV field");
  return [...values, field.trim()];
}

/** NVIDIA documents compute_cap as a query field; older drivers may omit it.
 * https://docs.nvidia.com/cuda/cuda-programming-guide/05-appendices/compute-capabilities.html */
export function parseNvidiaSmi(source: string): GpuDevice[] {
  return source.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const columns = csvRow(line);
    if (columns.length !== 6 && columns.length !== 7) throw new Error("Unexpected NVIDIA inventory columns");
    const [uuid, name, pci, total, used, driver, capability] = columns;
    if (!/^GPU-[\w-]+$/.test(uuid) || !Number.isFinite(Number(total)) || Number(total) <= 0) throw new Error("Invalid NVIDIA inventory row");
    const usedBytes = value(used) !== null && Number.isFinite(Number(used)) && Number(used) >= 0 ? Number(used) * MIB : null;
    const compute = capability?.match(/^(\d+)\.(\d+)$/);
    return {
      id: `nvidia:${uuid}`, vendor: "nvidia", name, uuid, pciAddress: pciAddress(pci),
      architecture: compute ? `sm_${compute[1]}${compute[2]}` : null,
      memory: { totalBytes: Number(total) * MIB, usedBytes: usedBytes !== null && usedBytes <= Number(total) * MIB ? usedBytes : null },
      driverVersion: value(driver),
    };
  });
}

interface AmdStaticDevice { pciAddress: string; name: string | null; architecture: string | null; uuid: string | null; driverVersion: string | null; totalBytes: number | null }
function object(input: unknown): Record<string, unknown> | null { return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null; }
function lowercase(input: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(input).map(([key, val]) => [key.toLowerCase(), val])); }
function memoryBytes(input: unknown): number | null {
  // amd-smi static VRAM_SIZE is reported with an explicit unit. Do not guess
  // whether an unlabelled number means bytes or MiB across utility versions.
  const quantity = lowercase(object(input) ?? {});
  const labelled = typeof input === "string" ? input :
    (typeof quantity.value === "number" || typeof quantity.value === "string") && typeof quantity.unit === "string" ? `${quantity.value} ${quantity.unit}` : null;
  const match = labelled?.trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|KiB|MB|MiB|GB|GiB)$/i);
  if (!match) return null;
  const scale = { b: 1, kb: 1024, kib: 1024, mb: MIB, mib: MIB, gb: 1024 ** 3, gib: 1024 ** 3 }[match[2].toLowerCase()];
  const bytes = Number(match[1]) * scale!;
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

function amdRuntimeUuid(input: unknown): string | null {
  const uuid = value(input)?.replace(/^(?:0x|GPU-)/i, "");
  // Older AMD-SMI versions expose a dashed UUID unrelated to ROCr's 64-bit
  // physical identifier. It must not become a ROCR_VISIBLE_DEVICES selector.
  return uuid && /^[a-f\d]{1,16}$/i.test(uuid) && !/^0+$/.test(uuid) ? uuid.toLowerCase() : null;
}

/** Accept the documented nested static JSON fields without depending on GPU
 * enumeration indices. https://rocm.docs.amd.com/projects/amdsmi/en/latest/how-to/amdsmi-cli-tool.html */
export function parseAmdSmi(source: string): AmdStaticDevice[] {
  const result: AmdStaticDevice[] = [];
  function visit(input: unknown, depth = 0) {
    if (depth > 8) return;
    if (Array.isArray(input)) { input.forEach((item) => visit(item, depth + 1)); return; }
    const raw = object(input);
    if (!raw) return;
    const entry = lowercase(raw);
    const bus = lowercase(object(entry.bus) ?? {}), asic = lowercase(object(entry.asic) ?? {});
    const address = pciAddress(bus.bdf ?? entry.bdf);
    if (address && Object.keys(asic).length) {
      const driver = lowercase(object(entry.driver) ?? {}), vram = lowercase(object(entry.vram) ?? {});
      const architecture = value(asic.target_graphics_version);
      result.push({ pciAddress: address, name: value(asic.market_name), architecture: architecture && /^gfx[a-f\d]+$/i.test(architecture) ? architecture.toLowerCase() : null,
        uuid: amdRuntimeUuid(entry.uuid), driverVersion: value(driver.version), totalBytes: memoryBytes(vram.size ?? vram.vram_size) });
      return;
    }
    Object.values(raw).forEach((item) => visit(item, depth + 1));
  }
  visit(JSON.parse(source));
  return result;
}

async function optional(probe: HardwareProbe, path: string) { try { return (await probe.readFile(path)).trim(); } catch { return null; } }

async function nvidia(probe: HardwareProbe, diagnostics: Diagnostic[]): Promise<GpuDevice[]> {
  const fields = "uuid,name,pci.bus_id,memory.total,memory.used,driver_version";
  try {
    return parseNvidiaSmi(await probe.command("nvidia-smi", [`--query-gpu=${fields},compute_cap`, "--format=csv,noheader,nounits"], commandOptions));
  } catch (error) {
    // A missing executable cannot succeed with a narrower query.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      try {
        const devices = parseNvidiaSmi(await probe.command("nvidia-smi", [`--query-gpu=${fields}`, "--format=csv,noheader,nounits"], commandOptions));
        diagnostics.push({ code: "nvidia-architecture-unavailable", severity: "warning", source: "nvidia-smi", message: "GPU inventory is available, but the compute architecture query failed." });
        return devices;
      } catch { /* Report the failed probe without leaking command stderr. */ }
    }
    diagnostics.push({ code: "nvidia-probe-unavailable", severity: "warning", source: "nvidia-smi", message: "NVIDIA inventory could not be read. Check the driver, utility and device access if NVIDIA hardware is expected." });
    return [];
  }
}

async function amd(probe: HardwareProbe, diagnostics: Diagnostic[]): Promise<GpuDevice[]> {
  if (probe.platform !== "linux") {
    diagnostics.push({ code: "amd-probe-unsupported", severity: "info", source: "sysfs", message: "Automatic AMD detection currently requires Linux sysfs. An external worker can be configured on other hosts." });
    return [];
  }
  const devices: GpuDevice[] = [];
  let entries: string[] = [];
  try { entries = await probe.readDirectory("/sys/class/drm"); }
  catch { diagnostics.push({ code: "amd-sysfs-unavailable", severity: "warning", source: "sysfs", message: "GPU sysfs is not visible in this process. Device detection may be incomplete." }); }
  for (const entry of entries.filter((name) => /^card\d+$/.test(name)).sort()) {
    const root = `/sys/class/drm/${entry}/device`;
    if ((await optional(probe, `${root}/vendor`))?.toLowerCase() !== "0x1002") continue;
    const [total, used, unique, name, device] = await Promise.all(["mem_info_vram_total", "mem_info_vram_used", "unique_id", "product_name", "device"].map((file) => optional(probe, `${root}/${file}`)));
    let address: string | null = null;
    try { address = pciAddress(basename(await probe.realpath(root))); } catch { /* Keep a diagnostic below. */ }
    if (!address || !total || !Number.isSafeInteger(Number(total)) || Number(total) <= 0) {
      diagnostics.push({ code: "amd-device-incomplete", severity: "warning", source: entry, message: "An AMD device was found, but its PCI identity or VRAM capacity could not be read." });
      continue;
    }
    const uuid = amdRuntimeUuid(unique);
    devices.push({ id: uuid ? `amd:${uuid}` : `amd:pci:${address}`, vendor: "amd", name: name || `AMD ${device || address}`,
      architecture: null, pciAddress: address, uuid, memory: { totalBytes: Number(total), usedBytes: used !== null && Number.isSafeInteger(Number(used)) && Number(used) >= 0 && Number(used) <= Number(total) ? Number(used) : null }, driverVersion: null });
  }
  let statics: AmdStaticDevice[] = [];
  try { statics = parseAmdSmi(await probe.command("amd-smi", ["static", "--json"], commandOptions)); }
  catch {
    diagnostics.push({ code: "amd-smi-unavailable", severity: "info", source: "amd-smi", message: "AMD runtime architecture information is unavailable; sysfs inventory is retained when visible." });
  }
  for (const detail of statics) {
    const found = devices.find((gpu) => gpu.pciAddress === detail.pciAddress);
    if (found) {
      found.name = detail.name ?? found.name;
      found.architecture = detail.architecture;
      found.driverVersion = detail.driverVersion;
    } else if (detail.totalBytes) {
      devices.push({ id: `amd:pci:${detail.pciAddress}`, vendor: "amd", name: detail.name ?? `AMD ${detail.pciAddress}`, architecture: detail.architecture,
        pciAddress: detail.pciAddress, uuid: detail.uuid, memory: { totalBytes: detail.totalBytes, usedBytes: null }, driverVersion: detail.driverVersion });
    }
  }
  for (const device of devices) if (device.id.startsWith("amd:pci:")) diagnostics.push({ code: "pci-identity-fallback", severity: "info", source: device.id, message: "This device has no readable persistent UUID. Its PCI identity must be reviewed after moving hardware." });
  return devices;
}

export async function detectHardware(options: { probe?: HardwareProbe; now?: () => Date } = {}): Promise<HardwareInventory> {
  const probe = options.probe ?? defaultProbe;
  const diagnostics: Diagnostic[] = [];
  const [nvidiaDevices, amdDevices, meminfo, cgroup, docker, podman] = await Promise.all([
    nvidia(probe, diagnostics), amd(probe, diagnostics), optional(probe, "/proc/meminfo"), optional(probe, "/proc/1/cgroup"), optional(probe, "/.dockerenv"), optional(probe, "/run/.containerenv"),
  ]);
  const markers = [docker !== null ? "dockerenv" : null, podman !== null ? "containerenv" : null, cgroup && /docker|kubepods|libpod|containerd/.test(cgroup) ? "cgroup" : null].filter((item): item is string => item !== null);
  let totalBytes = probe.totalMemoryBytes, availableBytes = probe.freeMemoryBytes;
  const total = meminfo?.match(/^MemTotal:\s+(\d+)\s+kB$/m), available = meminfo?.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  if (total && available) { totalBytes = Number(total[1]) * 1024; availableBytes = Number(available[1]) * 1024; }
  // A container may see host meminfo while being constrained to much less RAM.
  if (markers.length) {
    const [limit, current] = await Promise.all([optional(probe, "/sys/fs/cgroup/memory.max"), optional(probe, "/sys/fs/cgroup/memory.current")]);
    if (limit && /^\d+$/.test(limit) && current && /^\d+$/.test(current)) {
      totalBytes = Math.min(totalBytes, Number(limit));
      availableBytes = Math.min(availableBytes, Math.max(0, Number(limit) - Number(current)));
    }
    diagnostics.push({ code: "container-visibility", severity: "warning", message: "Detection describes devices visible to this container, which may be a subset of the host." });
  }
  const gpus = [...nvidiaDevices, ...amdDevices].sort((a, b) => a.id.localeCompare(b.id));
  if (!gpus.length) diagnostics.push({ code: "no-visible-gpu", severity: "warning", message: "No GPU with usable inventory is visible. This does not establish that the host has no GPU." });
  return { schemaVersion: 1, detectedAt: (options.now?.() ?? new Date()).toISOString(), host: { platform: probe.platform, architecture: probe.architecture, logicalCpuCount: probe.logicalCpuCount,
    memory: { totalBytes, availableBytes: Math.min(totalBytes, Math.max(0, availableBytes)) }, container: { detected: markers.length > 0, markers } }, gpus, diagnostics };
}
