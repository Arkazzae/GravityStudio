import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRuntimeDeployment, formatRuntimeCommand, managedRuntimeProfiles } from "../../scripts/runtime-plan.ts";
import { parseRuntimeArguments } from "../../scripts/runtime.ts";
import { dualR9700, inventory, singleB100, triple3090 } from "../hardware/fixtures.ts";
import lock from "../../deploy/comfyui/runtime.lock.json" with { type: "json" };

test("three 3090 workers share one pinned CUDA image and model directory", () => {
  const plan = createRuntimeDeployment(triple3090(), { dataDirectory: "/tmp/gravity-deploy-test", engine: "docker" });
  assert.equal(plan.build.length, 1);
  assert.equal(plan.workers.length, 3);
  assert.equal(new Set(plan.workers.map((worker) => worker.image)).size, 1);
  for (const [index, worker] of plan.workers.entries()) {
    assert.equal(worker.baseUrl, `http://127.0.0.1:${8188 + index}`);
    assert.ok(worker.create.args.includes(`device=GPU-3090-${index + 1}`));
    assert.ok(worker.create.args.includes("type=bind,src=/tmp/gravity-deploy-test/models,dst=/models,readonly"));
    const service = plan.compose.services[worker.containerName];
    assert.deepEqual(service.ports, [`127.0.0.1:${8188 + index}:8188`]);
    assert.equal((service.deploy as { resources: { reservations: { devices: { count?: number; device_ids: string[] }[] } } }).resources.reservations.devices[0].count, undefined);
  }
  assert.equal(plan.diagnostics.filter((item) => item.severity === "error").length, 0);
});

test("two R9700 workers use ROCm UUID placement and numeric Docker device groups", () => {
  const plan = createRuntimeDeployment(dualR9700(), { dataDirectory: "/tmp/gravity-rocm", supplementalGroupIds: [44, 109] });
  assert.equal(plan.build.length, 1);
  assert.equal(plan.workers.length, 2);
  assert.ok(plan.workers.every((worker) => worker.backend === "rocm"));
  assert.ok(plan.workers[0].create.args.includes("ROCR_VISIBLE_DEVICES=GPU-000000000009700a"));
  assert.deepEqual(plan.compose.services[plan.workers[0].id].group_add, ["44", "109"]);
  assert.ok(plan.workers[0].create.args.includes("/dev/kfd"));
  assert.ok(!plan.workers[0].create.args.includes("--privileged"));
});

test("B100 gets one CUDA worker; mixed hosts get one image per backend", () => {
  const b100 = createRuntimeDeployment(singleB100(), { dataDirectory: "/tmp/gravity-b100" });
  assert.equal(b100.workers.length, 1);
  assert.ok(!b100.diagnostics.some((item) => item.severity === "error"));
  const mixed = inventory([dualR9700().gpus[0], triple3090().gpus[0]]);
  const plan = createRuntimeDeployment(mixed, { dataDirectory: "/tmp/gravity-mixed", engine: "podman" });
  assert.equal(plan.build.length, 2);
  const cuda = plan.workers.find((worker) => worker.backend === "cuda")!;
  const rocm = plan.workers.find((worker) => worker.backend === "rocm")!;
  assert.ok(cuda.create.args.includes("nvidia.com/gpu=GPU-3090-1"));
  assert.ok(!cuda.create.args.includes("--gpus"));
  assert.ok(rocm.create.args.includes("keep-groups"));
  assert.ok(rocm.create.args.includes("crun"));
  for (const worker of plan.workers) {
    assert.equal(worker.create.args[worker.create.args.indexOf("--userns") + 1], "keep-id");
    assert.equal(plan.compose.services[worker.id].userns_mode, "keep-id");
  }
});

test("a missing UUID, unsupported host or absent GPU produces a blocking plan diagnostic", () => {
  const hardware = dualR9700();
  hardware.gpus[0].uuid = null;
  const plan = createRuntimeDeployment(hardware, { dataDirectory: "/tmp/gravity-invalid" });
  assert.ok(plan.diagnostics.some((item) => item.code === "gpu-uuid-required"));
  const unsupported = createRuntimeDeployment({ ...hardware, host: { ...hardware.host, architecture: "arm64" } }, { dataDirectory: "/tmp/gravity-arm" });
  assert.ok(unsupported.diagnostics.some((item) => item.code === "unsupported-host"));
  const absent = createRuntimeDeployment(hardware, { dataDirectory: "/tmp/gravity-none", gpuIds: ["absent"] });
  assert.equal(absent.workers.length, 0);
  assert.ok(absent.diagnostics.some((item) => item.code === "unknown-gpu"));
});

test("public builds pin official image digests, source bytes and binary dependency hashes", async () => {
  assert.match(lock.comfyui.commit, /^[a-f0-9]{40}$/);
  assert.match(lock.comfyui.archiveSha256, /^[a-f0-9]{64}$/);
  for (const profile of Object.values(lock.profiles)) {
    assert.match(profile.baseImage, /^docker\.io\/(pytorch|rocm)\/pytorch:[^@]+@sha256:[a-f0-9]{64}$/);
    assert.ok(!profile.baseImage.includes("localhost"));
  }
  const requirements = await readFile(new URL("../../deploy/comfyui/requirements.lock", import.meta.url), "utf8");
  const packages = requirements.split(/\n(?=[a-z])/).filter((block) => /^[a-z]/.test(block));
  assert.ok(packages.length >= 70);
  assert.ok(packages.every((block) => /^[a-z\d_.-]+==[^\s]+/i.test(block) && block.includes("--hash=sha256:")));
  assert.ok(!/^torch==|^torchvision==|^triton==|^nvidia-/m.test(requirements));
  const profiles = managedRuntimeProfiles();
  assert.ok(profiles.every((profile) => /^[a-f0-9]{64}$/.test(profile.revision)));
});

test("plan is the CLI default and generated commands do not interpolate path syntax", () => {
  assert.equal(parseRuntimeArguments([]).command, "plan");
  assert.throws(() => parseRuntimeArguments(["up", "--engine", "sh"]));
  assert.throws(() => createRuntimeDeployment(triple3090(), { dataDirectory: "/tmp/a,b" }));
  const plan = createRuntimeDeployment(triple3090(), { dataDirectory: "/tmp/literal-$(touch owned)'s" });
  const mount = plan.workers[0].create.args.find((arg) => arg.includes("dst=/models"))!;
  assert.ok(mount.includes("$(touch owned)'s"));
  assert.ok(formatRuntimeCommand(plan.workers[0].create).includes("'\\''"));
  assert.ok(JSON.stringify(plan.compose).includes("$$(touch owned)"));
});
