import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ApiMedia } from "../../apps/server/api-media.ts";
import { mcpResponse } from "../../apps/server/mcp.ts";
import { openaiImages } from "../../apps/server/openai-images.ts";
import { saveImportedExtension, saveImportedModel } from "../../apps/server/registry.ts";
import { settingsView } from "../../apps/server/settings.ts";
import { MAX_LORAS } from "../../packages/contracts/lora-stack.ts";
import { getModel, verifySnapshot, type GenerationExtensionManifest, type GenerationSnapshot } from "../../packages/inference/index.ts";
import { engineFixture, GiB, until } from "./helpers/engine-fixture.ts";

async function fixture(t: TestContext, memory = { ramBytes: GiB / 4, vramBytes: GiB / 8 }) {
  const f = await engineFixture();
  t.after(async () => { f.engine.ticking = false; await f.close(); });
  const extensions = Array.from({ length: MAX_LORAS }, (_, index): GenerationExtensionManifest => ({
    id: `stack-${index}`, name: `Stack adapter ${index}`, revision: "1", kind: "lora", category: "image", description: "Synthetic adapter manifest",
    familyIds: ["sdxl"], artifacts: [{ role: "lora", folder: "loras", filename: `stack/adapter-${index}.safetensors`, sha256: index.toString(16).padStart(64, "0") }], memory: { ...memory },
  }));
  for (const extension of extensions) saveImportedExtension(f.store, extension);
  f.workers[0].state.info.LoraLoader = {
    input: { required: { model: ["MODEL"], clip: ["CLIP"], lora_name: [extensions.map(item => item.artifacts[0].filename)], strength_model: ["FLOAT", { min: 0, max: 2 }], strength_clip: ["FLOAT", { min: 0, max: 2 }] } }, output: ["MODEL", "CLIP"],
  };
  const original = f.workers[0].state.responseOverride;
  const install = (filenames = extensions.map(item => item.artifacts[0].filename)) => {
    f.workers[0].state.responseOverride = path => path === "/models/loras" ? { body: JSON.stringify(filenames) } : original?.(path);
    f.engine.invalidateWorkers();
  };
  install();
  function checkpoint(maxLoras: number) {
    const model = { ...getModel("sdxl-base"), id: `sdxl-stack-${maxLoras}`, name: `Stack limit ${maxLoras}`, maxLoras };
    saveImportedModel(f.store, model);
    const settings = settingsView(f.store);
    const configuration = settings.modelConfigurations.find(item => item.modelId === model.id)!;
    configuration.enabled = true; configuration.workerIds = ["worker-0"];
    configuration.memory = { ramBytes: 8 * GiB, vramBytes: 6 * GiB, source: "estimate" };
    f.store.saveSettings(settings);
    return model.id;
  }
  const choices = extensions.map((item, index) => ({ id: item.id, strength: index % 5 / 2 }));
  return Object.assign(f, { extensions, choices, install, checkpoint });
}

test("a 32-LoRA submission freezes order, files, strengths and the complete memory reservation across restart", async t => {
  const f = await fixture(t);
  const choices = [...f.choices].reverse();
  const job = await f.queue({ loras: choices });
  const saved = f.store.job(job.id);
  const snapshot = saved.snapshot as GenerationSnapshot;
  assert.deepEqual(snapshot.parameters.loras, choices);
  assert.deepEqual(snapshot.extensions!.map(item => item.id), choices.map(item => item.id));
  assert.equal(snapshot.extensions!.length, 32);
  assert.deepEqual(saved.placements[0].memory, { ramBytes: 16 * GiB, vramBytes: 10 * GiB });
  for (const [index, selected] of choices.entries()) {
    assert.equal(snapshot.graph[`lora_${index}`].inputs.lora_name, f.extensions.find(item => item.id === selected.id)!.artifacts[0].filename);
    assert.equal(snapshot.graph[`lora_${index}`].inputs.strength_model, selected.strength);
    assert.equal(snapshot.graph[`lora_${index}`].inputs.strength_clip, selected.strength);
    assert.deepEqual(snapshot.graph[`lora_${index}`].inputs.model, index ? [`lora_${index - 1}`, 0] : ["checkpoint", 0]);
    assert.deepEqual(snapshot.graph[`lora_${index}`].inputs.clip, index ? [`lora_${index - 1}`, 1] : ["checkpoint", 1]);
  }
  assert.deepEqual(snapshot.graph.sample.inputs.model, ["lora_31", 0]);
  verifySnapshot(snapshot);
  const changed = f.extensions.at(-1)!;
  saveImportedExtension(f.store, { ...changed, revision: "2", artifacts: [{ ...changed.artifacts[0], filename: "replacement.safetensors" }] });
  choices[0].strength = .1;
  await f.restart(); await f.engine.tick();
  await until(() => f.store.job(job.id).status === "running");
  const running = f.store.job(job.id).snapshot as GenerationSnapshot;
  verifySnapshot(running);
  assert.equal(running.hash, snapshot.hash);
  assert.equal(running.extensions![0].revision, "1");
  assert.equal(running.graph.lora_0.inputs.lora_name, changed.artifacts[0].filename);
  assert.notEqual(running.parameters.loras![0].strength, choices[0].strength);
  f.complete(0, f.store.job(job.id).promptId!);
  await until(() => f.store.job(job.id).status === "succeeded");
});

test("model-specific LoRA limits are advertised and enforced, including checkpoints with no LoRA support", async t => {
  const f = await fixture(t), narrow = f.checkpoint(2), disabled = f.checkpoint(0);
  const catalog = await f.engine.catalog();
  assert.equal(catalog.models.find(model => model.id === "sdxl-base")!.capabilities.loras.max, 32);
  assert.equal(catalog.models.find(model => model.id === "ideogram-4-fp8")!.capabilities.loras.max, 0);
  assert.equal(catalog.models.find(model => model.id === narrow)!.capabilities.loras.max, 2);
  assert.equal(catalog.models.find(model => model.id === disabled)!.capabilities.loras.max, 0);
  await assert.rejects(f.queue({ modelId: narrow, loras: f.choices.slice(0, 3) }), { code: "INVALID_LORAS" });
  await assert.rejects(f.queue({ modelId: disabled, loras: f.choices.slice(0, 1) }), { code: "INVALID_LORAS" });
  assert.equal(f.store.jobs(f.owner.id).length, 0);
  const tools = await f.engine.generationTools(disabled);
  assert.ok(tools.tools.filter(tool => tool.kind === "lora").every(tool => tool.ready === false));
  assert.ok(tools.tools.filter(tool => tool.familyIds.includes("sdxl") && tool.kind === "lora").every(tool => tool.missingReasons[0] === "This checkpoint does not support LoRAs."));
  const accepted = await f.queue({ modelId: narrow, loras: f.choices.slice(0, 2) });
  assert.equal((f.store.job(accepted.id).snapshot as GenerationSnapshot).parameters.loras!.length, 2);
});

test("invalid, duplicated, incompatible and missing LoRAs cannot create a job or reach worker submission", async t => {
  const f = await fixture(t);
  for (const loras of [
    [...f.choices, { id: "extra", strength: 1 }], [f.choices[0], f.choices[0]], [{ id: "../adapter", strength: 1 }],
    [{ id: f.choices[0].id, strength: NaN }], [{ id: f.choices[0].id, strength: Infinity }],
    [{ id: f.choices[0].id, strength: -.1 }], [{ id: f.choices[0].id, strength: 2.1 }],
    [{ ...f.choices[0], extra: true }],
  ]) await assert.rejects(f.queue({ loras }), { code: "INVALID_LORAS" });
  await assert.rejects(f.queue({ loras: null } as unknown as Parameters<typeof f.queue>[0]), { code: "INVALID_LORAS" });
  await assert.rejects(f.queue({ loras: [{ id: "not-registered", strength: 1 }] }), { code: "INVALID_INPUT" });
  saveImportedExtension(f.store, { ...f.extensions[0], id: "wrong-family", familyIds: ["krea-2"] });
  await assert.rejects(f.queue({ loras: [{ id: "wrong-family", strength: 1 }] }), { code: "INVALID_INPUT" });
  f.install(f.extensions.slice(0, -1).map(item => item.artifacts[0].filename));
  await assert.rejects(f.queue({ loras: f.choices }), { code: "MODEL_UNAVAILABLE" });
  f.install(); delete f.workers[0].state.info.LoraLoader; f.engine.invalidateWorkers();
  await assert.rejects(f.queue({ loras: f.choices }), { code: "MODEL_UNAVAILABLE" });
  assert.equal(f.store.jobs(f.owner.id).length, 0);
  assert.equal(f.workers[0].state.requests.some(request => request.path === "/prompt" && request.method === "POST"), false);
});

test("an oversized stack budget fails capacity admission before posting a workflow to the worker", async t => {
  const f = await fixture(t, { ramBytes: GiB, vramBytes: GiB });
  const job = await f.queue({ loras: f.choices.slice(0, 12) });
  assert.equal(f.store.job(job.id).placements[0].memory.vramBytes, 18 * GiB);
  await f.engine.tick();
  const rejected = f.store.job(job.id);
  assert.equal(rejected.status, "failed");
  assert.match(rejected.error!, /VRAM budget.*capacity/);
  assert.equal(f.workers[0].state.submissions.length, 0);
  assert.equal(f.workers[0].state.requests.some(request => request.path === "/prompt" && request.method === "POST"), false);
});

async function rpc(f: Awaited<ReturnType<typeof fixture>>, method: string, params: Record<string, unknown>) {
  const body = { jsonrpc: "2.0", id: 1, method, params };
  const request = new Request("http://localhost/api/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify(body) });
  const response = await mcpResponse(f.engine, f.store, f.owner.id, request, body);
  assert.equal(response.status, 200);
  const text = await response.text();
  return JSON.parse(response.headers.get("content-type")?.includes("text/event-stream") ? text.split("\n").find(line => line.startsWith("data: "))!.slice(6) : text);
}

test("MCP advertises and accepts 32 LoRAs while rejecting larger, duplicated and model-limited stacks", async t => {
  const f = await fixture(t); f.engine.ticking = true;
  const tools = (await rpc(f, "tools/list", {})).result.tools;
  const schema = tools.find((tool: { name: string }) => tool.name === "gravity_job_submit").inputSchema;
  assert.equal(schema.properties.request.properties.loras.maxItems, 32);
  const submit = (modelId: string, loras: unknown) => rpc(f, "tools/call", { name: "gravity_job_submit", arguments: { request: { modelId, prompt: "A ceramic cup", seed: 42, loras }, idempotencyKey: randomUUID() } });
  const accepted = await submit("sdxl-base", f.choices);
  assert.equal(accepted.result.isError, undefined);
  const job = accepted.result.structuredContent.data.job;
  assert.equal((f.store.job(job.id).snapshot as GenerationSnapshot).parameters.loras!.length, 32);
  for (const loras of [[...f.choices, { id: "extra", strength: 1 }], [f.choices[0], f.choices[0]], [{ id: "bad/id", strength: 1 }]]) {
    const rejected = await submit("sdxl-base", loras);
    assert.ok(rejected.error || rejected.result?.isError);
  }
  const narrowed = await submit(f.checkpoint(2), f.choices.slice(0, 3));
  assert.equal(narrowed.result.structuredContent.data.error.code, "INVALID_LORAS");
  assert.equal(f.store.jobs(f.owner.id).length, 1);
});

test("OpenAI studio.loras accepts 32 and validates the shared stack contract before creating jobs", async t => {
  const f = await fixture(t); f.engine.ticking = true;
  const media = new ApiMedia(f.store);
  const request = (loras: unknown, model = "sdxl-base") => openaiImages({
    engine: f.engine, store: f.store, media, userId: f.owner.id,
    body: { model, prompt: "A ceramic cup", studio: { seed: 42, loras } }, editing: false, key: randomUUID(),
    signal: new AbortController().signal, origin: "https://studio.example", asynchronous: true, authorize() {},
  });
  const accepted = await request(f.choices);
  assert.equal(accepted.status, 202);
  const job = (await accepted.json()).jobs[0];
  assert.equal((f.store.job(job.id).snapshot as GenerationSnapshot).parameters.loras!.length, 32);
  for (const loras of [[...f.choices, { id: "extra", strength: 1 }], [f.choices[0], f.choices[0]], [{ id: "bad/id", strength: 1 }], [{ id: "stack-0", strength: 2.1 }], [{ id: "stack-0", strength: NaN }]]) {
    await assert.rejects(request(loras), { code: "INVALID_IMAGE_REQUEST" });
  }
  await assert.rejects(request(f.choices.slice(0, 3), f.checkpoint(2)), { code: "INVALID_LORAS" });
  assert.equal(f.store.jobs(f.owner.id).length, 1);
});
