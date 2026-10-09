import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagedTextContainer, localTextGpuSupport, textModelAllocation } from "../../scripts/text-runtime.ts";
import type { TextRuntimeOptions } from "../../scripts/text-runtime.ts";
import type { RuntimeRunner } from "../../scripts/runtime-control.ts";
import type { ContainerEngine, RuntimeCommand } from "../../scripts/runtime-plan.ts";
import lock from "../../deploy/llamacpp/runtime.lock.json" with { type: "json" };
import { dualR9700, singleB100, triple3090 } from "../hardware/fixtures.ts";

const imageId = `sha256:${"a".repeat(64)}`, containerId = "b".repeat(64);
const validLogs = "load_tensors: offloaded 33/33 layers to GPU\nload_tensors:        ROCm0 model buffer size =  8700.15 MiB\n";
type Inspected = { Id: string; Image: string; Name: string; State: { Running: boolean; Status: string }; Config: { Labels: Record<string, string> } };

async function fixture(t: { after: (fn: () => Promise<void>) => void }, overrides: TextRuntimeOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gravity-text-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modelPath = join(directory, "model.gguf");
  await writeFile(modelPath, "GGUF");
  const state = { info: null as Inspected | null, imagePresent: false, imageRevision: lock.revision,
    engineDown: false, refuseStop: false, logs: validLogs, createFailure: false };
  const calls: RuntimeCommand[] = [];
  const run: RuntimeRunner = async command => {
    calls.push(structuredClone(command));
    const args = command.args;
    const output = (stdout = "", stderr = "") => ({ stdout, stderr });
    if (state.engineDown) throw new Error("Engine unavailable");
    if (args[0] === "image" && args[1] === "ls") return output(state.imagePresent ? imageId : "");
    if (args[0] === "pull") { state.imagePresent = true; return output(); }
    if (args[0] === "image" && args[1] === "inspect") return output(JSON.stringify({
      Id: imageId, Architecture: "amd64", Os: "linux", RepoDigests: [args.at(-1)], Config: { Labels: { "org.opencontainers.image.revision": state.imageRevision } },
    }));
    if (args[0] === "create") {
      if (state.createFailure) throw new Error("Create failed");
      const labels = Object.fromEntries(args.flatMap((arg, index) => arg === "--label" ? [args[index + 1].split(/=(.*)/s).slice(0, 2)] : []));
      state.info = { Id: containerId, Image: imageId, Name: args[args.indexOf("--name") + 1], State: { Running: false, Status: "created" }, Config: { Labels: labels } };
      return output(containerId);
    }
    if (args[0] === "container" && args[1] === "ls") return output(state.info?.Name ?? "");
    if (args[0] === "container" && args[1] === "inspect") { assert.ok(state.info); return output(JSON.stringify(state.info)); }
    if (args[0] === "container" && args[1] === "start") { assert.equal(args.at(-1), state.info?.Id); state.info!.State = { Running: true, Status: "running" }; return output(); }
    if (args[0] === "container" && args[1] === "stop") {
      assert.equal(args.at(-1), state.info?.Id);
      if (!state.refuseStop) state.info!.State = { Running: false, Status: "exited" };
      return output();
    }
    if (args[0] === "container" && args[1] === "rm") { assert.equal(args.at(-1), state.info?.Id); assert.equal(state.info?.State.Running, false); state.info = null; return output(); }
    if (args[0] === "container" && args[1] === "logs") return output("", state.logs);
    assert.fail(`Unexpected runtime command: ${JSON.stringify(command)}`);
  };
  const options: TextRuntimeOptions = {
    run, async fetch() { return new Response('{"status":"ok"}'); }, async portAvailable() { return true; },
    async inspectPrerequisites() { return { ready: true, checks: [], supplementalGroupIds: [44, 109] }; }, ...overrides,
  };
  return { runtime: new ManagedTextContainer(directory, options), options, directory, modelPath, state, calls, hardware: dualR9700() };
}

test("GPU profiles include R9700, RTX3090 and B100 but require known architecture and UUID", () => {
  for (const hardware of [dualR9700(), triple3090(), singleB100()]) assert.equal(localTextGpuSupport(hardware.gpus[0]).supported, true);
  const gpu = dualR9700().gpus[0];
  assert.equal(localTextGpuSupport({ ...gpu, architecture: null }).supported, false);
  assert.equal(localTextGpuSupport({ ...gpu, architecture: "gfx9999" }).supported, false);
  assert.equal(localTextGpuSupport({ ...gpu, uuid: null }).supported, false);
});

test("preparation pulls and verifies an immutable image without starting a process", async t => {
  const f = await fixture(t);
  await f.runtime.prepare(f.hardware.gpus[0], f.hardware);
  assert.ok(f.calls.some(command => command.args[0] === "pull" && command.args.at(-1) === lock.profiles.rocm.image));
  assert.ok(!f.calls.some(command => command.args[0] === "create" || command.args[1] === "start"));
  await f.runtime.prepare(f.hardware.gpus[0], f.hardware);
  assert.equal(f.calls.filter(command => command.args[0] === "pull").length, 1);
  assert.deepEqual(await f.runtime.status(), { running: false, containerId: null, gpuId: null, baseUrl: null });
});

test("AMD startup selects only its UUID and keeps model and API key private", async t => {
  const f = await fixture(t, { async portAvailable(port) { return port !== 18401; } });
  const result = await f.runtime.start(f.hardware.gpus[1], f.hardware, f.modelPath);
  assert.equal(result.baseUrl, "http://127.0.0.1:18402/v1");
  assert.equal(result.modelId, "mimo-v2.6-distill-qwen-9b");
  assert.equal(result.containerId, containerId);
  assert.equal(result.allocatedVramBytes, Math.floor(8700.14 * 1024 ** 2));
  assert.match(result.apiKey, /^[a-f\d]{64}$/);
  const create = f.calls.find(command => command.args[0] === "create")!;
  assert.equal(create.program, "podman");
  assert.ok(create.args.includes("ROCR_VISIBLE_DEVICES=GPU-000000000009700b"));
  for (const flag of ["--read-only", "no-new-privileges", "keep-groups", "--no-webui", "--no-mmproj", "--jinja"]) assert.ok(create.args.includes(flag));
  for (const [flag, expected] of [["--restart", "no"], ["--parallel", "1"], ["--fit", "off"], ["--ctx-size", "8192"], ["--sleep-idle-seconds", "-1"], ["--reasoning", "off"], ["--chat-template-kwargs", '{"enable_thinking":false}']]) assert.equal(create.args[create.args.indexOf(flag) + 1], expected);
  assert.ok(create.args.some(arg => arg === `type=bind,src=${f.modelPath},dst=/models/model.gguf,readonly`));
  const serialized = JSON.stringify(f.calls) + await readFile(join(f.directory, "runtime", "text", "plan.json"), "utf8");
  assert.ok(!serialized.includes(result.apiKey));
  assert.equal((await stat(join(f.directory, "runtime", "text", "api-key"))).mode & 0o777, 0o600);
  assert.equal((await f.runtime.status()).containerId, containerId);
  await f.runtime.stop();
  assert.equal((await f.runtime.status()).running, false);
  assert.ok(f.calls.some(command => command.args[1] === "stop" && command.args.at(-1) === containerId));
  assert.ok(f.calls.some(command => command.args[1] === "rm" && command.args.at(-1) === containerId));
});

for (const engine of ["docker", "podman"] as const) test(`NVIDIA ${engine} uses the selected physical UUID`, async t => {
  const f = await fixture(t, { async inspectPrerequisites(_inventory, candidate) { return { ready: candidate === engine, checks: [], supplementalGroupIds: [] }; } });
  const hardware = triple3090();
  f.state.logs = validLogs.replace("ROCm0", "CUDA0");
  await f.runtime.start(hardware.gpus[2], hardware, f.modelPath);
  const create = f.calls.find(command => command.args[0] === "create")!;
  assert.equal(create.program, engine);
  assert.ok(create.args.includes(engine === "docker" ? "device=GPU-3090-3" : "nvidia.com/gpu=GPU-3090-3"));
  assert.ok(!create.args.includes("/dev/kfd"));
  assert.ok(create.args.includes(lock.profiles.cuda.image));
  await f.runtime.stop();
});

test("startup recovery stops the saved owned container and preserves the selected engine", async t => {
  const f = await fixture(t);
  const started = await f.runtime.start(f.hardware.gpus[0], f.hardware, f.modelPath);
  const engines: (ContainerEngine | undefined)[] = [];
  const restarted = new ManagedTextContainer(f.directory, { ...f.options, async inspectPrerequisites(_hardware, engine) {
    engines.push(engine); return { ready: true, checks: [], supplementalGroupIds: [44, 109] };
  } });
  await restarted.recover();
  assert.equal(f.state.info, null);
  const second = await restarted.start(f.hardware.gpus[1], f.hardware, f.modelPath);
  assert.deepEqual(engines, ["podman"]);
  assert.equal(second.apiKey, started.apiKey);
  assert.equal((await restarted.status()).gpuId, f.hardware.gpus[1].id);
  await restarted.stop();
});

test("foreign containers are never stopped or removed, including recovery", async t => {
  const f = await fixture(t);
  await f.runtime.start(f.hardware.gpus[0], f.hardware, f.modelPath);
  f.state.info!.Config.Labels["io.gravity.owner"] = "someone-else";
  await assert.rejects(f.runtime.recover(), /does not belong/);
  assert.ok(!f.calls.some(command => ["stop", "rm"].includes(command.args[1])));
});

test("engine failure and an unconfirmed stop retain ownership and reject lease release", async t => {
  const f = await fixture(t);
  await f.runtime.start(f.hardware.gpus[0], f.hardware, f.modelPath);
  f.state.refuseStop = true;
  await assert.rejects(f.runtime.stop(), /keep its GPU reserved/);
  assert.ok(!f.calls.some(command => command.args[1] === "rm"));
  f.state.engineDown = true;
  await assert.rejects(f.runtime.stop(), /Engine unavailable/);
  f.state.engineDown = false; f.state.refuseStop = false;
  await f.runtime.stop();
});

test("failed readiness times out and removes its process before returning failure", async t => {
  const f = await fixture(t, { healthTimeoutMs: 20, async fetch() { return new Response("loading", { status: 503 }); } });
  await assert.rejects(f.runtime.start(f.hardware.gpus[0], f.hardware, f.modelPath), /abort|timeout/i);
  assert.equal(f.state.info, null);
  assert.ok(f.calls.some(command => command.args[1] === "stop"));
});

test("cancelled startup performs cleanup without the aborted request signal", async t => {
  const controller = new AbortController();
  const f = await fixture(t, { async fetch() { controller.abort(new Error("Request cancelled")); throw controller.signal.reason; } });
  await assert.rejects(f.runtime.start(f.hardware.gpus[0], f.hardware, f.modelPath, controller.signal), /Request cancelled/);
  assert.equal(f.state.info, null);
  assert.ok(f.calls.some(command => command.args[1] === "rm"));
});

test("image drift blocks startup and a failed create leaves a recoverable saved plan", async t => {
  const f = await fixture(t);
  f.state.imageRevision = "0".repeat(40);
  await assert.rejects(f.runtime.start(f.hardware.gpus[0], f.hardware, f.modelPath), /pinned digest/);
  assert.ok(!f.calls.some(command => command.args[0] === "create"));
  f.state.imageRevision = lock.revision; f.state.createFailure = true;
  await assert.rejects(f.runtime.start(f.hardware.gpus[0], f.hardware, f.modelPath), /Create failed/);
  assert.equal(JSON.parse(await readFile(join(f.directory, "runtime", "text", "plan.json"), "utf8")).version, 1);
  await f.runtime.recover();
});

test("active models cannot be silently replaced and a prepared stale GPU cannot start", async t => {
  const f = await fixture(t);
  await f.runtime.start(f.hardware.gpus[0], f.hardware, f.modelPath);
  await assert.rejects(f.runtime.start(f.hardware.gpus[1], f.hardware, f.modelPath), /already running/);
  assert.equal(f.state.info!.State.Running, true);
  await f.runtime.stop();
  await assert.rejects(f.runtime.start(f.hardware.gpus[0], { ...f.hardware, gpus: [] }, f.modelPath), /no longer present/);
});

test("an interrupted create is recovered even when the engine created a container before failing", async t => {
  const f = await fixture(t);
  const run = f.options.run!;
  const runtime = new ManagedTextContainer(f.directory, { ...f.options, async run(command, options) {
    const result = await run(command, options);
    if (command.args[0] === "create") throw new Error("Create client disconnected");
    return result;
  } });
  await assert.rejects(runtime.start(f.hardware.gpus[0], f.hardware, f.modelPath), /Create client disconnected/);
  assert.equal(f.state.info, null);
  assert.ok(f.calls.some(command => command.args[1] === "rm"));
});

test("tampered recovery metadata cannot target an arbitrary container", async t => {
  const f = await fixture(t);
  await f.runtime.start(f.hardware.gpus[0], f.hardware, f.modelPath);
  const path = join(f.directory, "runtime", "text", "plan.json");
  const plan = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...plan, containerName: "another-service" }));
  await assert.rejects(f.runtime.recover(), /Invalid saved/);
  assert.ok(!f.calls.some(command => ["stop", "rm"].includes(command.args[1])));
});

test("failed preflight and explicit occupied ports do not start a container", async t => {
  const f = await fixture(t, { port: 18401, async portAvailable() { return false; } });
  await assert.rejects(f.runtime.start(f.hardware.gpus[0], f.hardware, f.modelPath), /No free loopback port/);
  assert.ok(!f.calls.some(command => command.args[0] === "create"));
  const blocked = new ManagedTextContainer(f.directory, { ...f.options, async inspectPrerequisites() {
    return { ready: false, checks: [{ id: "engine", status: "failed", message: "No engine access" }], supplementalGroupIds: [] };
  } });
  await assert.rejects(blocked.prepare(f.hardware.gpus[0], f.hardware), /No engine access/);
});

test("only one fully offloaded model buffer yields a conservative allocation credit", () => {
  assert.equal(textModelAllocation(validLogs, "rocm"), Math.floor(8700.14 * 1024 ** 2));
  for (const logs of ["", validLogs.replace("33/33", "32/33"), validLogs.replace("ROCm0", "ROCm1"), validLogs + validLogs,
    validLogs.replace("model buffer", "KV buffer"), validLogs.replace("8700.15", "invalid"), validLogs + "load_tensors: ROCm1 model buffer size = 100.00 MiB"]) assert.equal(textModelAllocation(logs, "rocm"), 0);
  assert.equal(textModelAllocation(validLogs, "cuda"), 0);
});
