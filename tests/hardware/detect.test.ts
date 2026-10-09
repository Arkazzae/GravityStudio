import assert from "node:assert/strict";
import test from "node:test";
import { detectHardware, parseAmdSmi, parseNvidiaSmi } from "../../packages/hardware/src/index.ts";
import { amdStaticR9700, fakeProbe, GIB, nvidiaQuery, NOW } from "./fixtures.ts";

test("NVIDIA detection keeps three 3090 cards separate and bounds command execution", async () => {
  const csv = [1, 2, 3].map((i) => `GPU-3090-${i}, NVIDIA GeForce RTX 3090, 00000000:0${i}:00.0, 24576, 1024, 580.1, 8.6`).join("\n");
  const { probe, calls } = fakeProbe({ commands: { [nvidiaQuery]: csv }, directories: { "/sys/class/drm": [] } });
  const result = await detectHardware({ probe, now: () => NOW });
  assert.equal(result.gpus.length, 3);
  assert.deepEqual(result.gpus.map((gpu) => gpu.architecture), ["sm_86", "sm_86", "sm_86"]);
  assert.equal(result.gpus[0].memory.totalBytes, 24 * GIB);
  assert.equal(result.gpus[0].pciAddress, "0000:01:00.0");
  assert.equal(result.detectedAt, NOW.toISOString());
  assert.ok(calls.every((call) => call.timeoutMs === 2500 && call.maxOutputBytes === 1024 * 1024));
});

test("AMD sysfs detects two R9700 cards and enriches architecture by matching PCI addresses", async () => {
  const files: Record<string, string> = {}, paths: Record<string, string> = {};
  for (const index of [0, 1]) {
    const root = `/sys/class/drm/card${index}/device`;
    Object.assign(files, { [`${root}/vendor`]: "0x1002", [`${root}/device`]: "0x7550", [`${root}/unique_id`]: `abc${index}`,
      [`${root}/mem_info_vram_total`]: String(32 * GIB), [`${root}/mem_info_vram_used`]: String(GIB) });
    paths[root] = `/sys/devices/pci0000:00/0000:0${index + 1}:00.0`;
  }
  const amd = JSON.stringify([1, 0].map((index) => ({ gpu: index, bus: { bdf: `0000:0${index + 1}:00.0` }, asic: { market_name: "AMD Radeon AI PRO R9700", target_graphics_version: "gfx1201" }, driver: { version: "6.15.0" } })));
  const { probe } = fakeProbe({ files, paths, directories: { "/sys/class/drm": ["card1", "card0", "renderD128"] }, commands: { "amd-smi static --json": amd } });
  const result = await detectHardware({ probe, now: () => NOW });
  assert.equal(result.gpus.length, 2);
  assert.deepEqual(result.gpus.map((gpu) => gpu.id), ["amd:abc0", "amd:abc1"]);
  assert.ok(result.gpus.every((gpu) => gpu.architecture === "gfx1201" && gpu.memory.totalBytes === 32 * GIB));
  assert.equal(result.gpus[0].name, "AMD Radeon AI PRO R9700");
});

test("unsupported utilities report incomplete visibility rather than proving a GPU-free host", async () => {
  const result = await detectHardware({ probe: fakeProbe().probe, now: () => NOW });
  assert.equal(result.gpus.length, 0);
  assert.ok(result.diagnostics.some((item) => item.code === "nvidia-probe-unavailable"));
  assert.ok(result.diagnostics.some((item) => item.code === "amd-sysfs-unavailable"));
  assert.ok(result.diagnostics.some((item) => item.code === "no-visible-gpu"));
});

test("unknown compute architecture is retained as unknown even when the model name is familiar", () => {
  const result = parseNvidiaSmi("GPU-b100, NVIDIA B100, 0000:01:00.0, 196608, N/A, 580.1, N/A");
  assert.equal(result[0].architecture, null);
  assert.equal(result[0].memory.usedBytes, null);
  assert.throws(() => parseNvidiaSmi("GPU-b100, NVIDIA B100, 0000:01:00.0, invalid, 0, 580.1"));
});

test("container detection uses its cgroup RAM ceiling and reports limited hardware visibility", async () => {
  const { probe } = fakeProbe({ files: { "/.dockerenv": "", "/proc/meminfo": `MemTotal: ${128 * GIB / 1024} kB\nMemAvailable: ${100 * GIB / 1024} kB\n`,
    "/sys/fs/cgroup/memory.max": String(16 * GIB), "/sys/fs/cgroup/memory.current": String(4 * GIB) } });
  const result = await detectHardware({ probe, now: () => NOW });
  assert.equal(result.host.container.detected, true);
  assert.deepEqual(result.host.memory, { totalBytes: 16 * GIB, availableBytes: 12 * GIB });
  assert.ok(result.diagnostics.some((item) => item.code === "container-visibility"));
});

test("AMD JSON accepts uppercase nested fields but does not guess unlabeled VRAM units", () => {
  const rows = parseAmdSmi(JSON.stringify({ gpu_data: [{ GPU: 0, BUS: { BDF: "0000:03:00.0" }, ASIC: { MARKET_NAME: "AMD card", TARGET_GRAPHICS_VERSION: "gfx942" }, VRAM: { SIZE: "65536 MB" } },
    { GPU: 1, BUS: { BDF: "0000:04:00.0" }, ASIC: { MARKET_NAME: "AMD card", TARGET_GRAPHICS_VERSION: "N/A" }, VRAM: { SIZE: 65536 } }] }));
  assert.equal(rows[0].totalBytes, 64 * GIB);
  assert.equal(rows[1].totalBytes, null);
  assert.equal(rows[1].architecture, null);
});

test("AMD-SMI quantity objects retain both R9700 cards when sysfs is unavailable", async () => {
  const result = await detectHardware({ probe: fakeProbe({ commands: { "amd-smi static --json": amdStaticR9700 } }).probe });
  assert.equal(result.gpus.length, 2);
  assert.deepEqual(result.gpus.map((gpu) => gpu.pciAddress), ["0000:03:00.0", "0000:07:00.0"]);
  for (const gpu of result.gpus) {
    assert.equal(gpu.name, "AMD Radeon AI PRO R9700");
    assert.equal(gpu.architecture, "gfx1201");
    assert.equal(gpu.driverVersion, "6.19.14.31400100");
    assert.equal(gpu.memory.totalBytes, 32624 * 1024 ** 2);
    assert.equal(gpu.memory.usedBytes, null);
    assert.equal(gpu.uuid, null);
  }
});

test("AMD-SMI UUID does not replace the physical sysfs identifier used by ROCr", async () => {
  const staticReport = JSON.parse(amdStaticR9700);
  staticReport.gpu_data[0].uuid = "12345678-1234-1234-1234-123456789abc";
  staticReport.gpu_data[1].uuid = "12345678-1234-1234-1234-123456789def";
  const root = "/sys/class/drm/card0/device";
  const { probe } = fakeProbe({
    files: { [`${root}/vendor`]: "0x1002", [`${root}/unique_id`]: "0xABCDEF0000000001", [`${root}/mem_info_vram_total`]: String(32 * GIB) },
    paths: { [root]: "/sys/devices/pci0000:00/0000:03:00.0" },
    directories: { "/sys/class/drm": ["card0"] },
    commands: { "amd-smi static --json": JSON.stringify(staticReport) },
  });
  const result = await detectHardware({ probe });
  const physical = result.gpus.find((gpu) => gpu.pciAddress === "0000:03:00.0")!;
  const fallback = result.gpus.find((gpu) => gpu.pciAddress === "0000:07:00.0")!;
  assert.equal(physical.id, "amd:abcdef0000000001");
  assert.equal(physical.uuid, "abcdef0000000001");
  assert.equal(physical.memory.totalBytes, 32 * GIB);
  assert.equal(fallback.uuid, null);
  assert.equal(fallback.id, "amd:pci:0000:07:00.0");
});

test("AMD memory quantities reject missing, unsupported or invalid units", () => {
  for (const size of [{ value: 32624 }, { value: -1, unit: "MB" }, { value: 32624, unit: "unknown" }, { value: null, unit: "MB" }]) {
    const staticReport = JSON.parse(amdStaticR9700);
    staticReport.gpu_data[0].vram.size = size;
    assert.equal(parseAmdSmi(JSON.stringify(staticReport))[0].totalBytes, null);
  }
});

test("NVIDIA architecture fallback retains inventory when an older query field is rejected", async () => {
  const { probe } = fakeProbe();
  probe.command = async (_file, args) => {
    if (args[0].includes("compute_cap")) throw new Error("Unsupported field");
    if (args[0].startsWith("--query-gpu")) return "GPU-old, NVIDIA GPU, 0000:01:00.0, 24576, 0, 550.1";
    throw new Error("No AMD utility");
  };
  const result = await detectHardware({ probe, now: () => NOW });
  assert.equal(result.gpus.length, 1);
  assert.equal(result.gpus[0].architecture, null);
  assert.ok(result.diagnostics.some((item) => item.code === "nvidia-architecture-unavailable"));
});
