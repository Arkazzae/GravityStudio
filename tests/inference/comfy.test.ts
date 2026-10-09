import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ComfyClient, checkCapabilities, compileGeneration, getModel } from "../../packages/inference/index.ts";
import type { ComfyProgress } from "../../packages/inference/index.ts";
import { completed, fakeComfy, PNG } from "./fake-comfy.ts";

const snapshot = () => compileGeneration({ modelId: "sdxl-base", prompt: "A ceramic cup", seed: 42 });

test("discovers actual HTTP node schemas and model inventory, including older loader APIs", async t => {
  const worker = await fakeComfy(); t.after(worker.close);
  const client = new ComfyClient(worker.url);
  assert.deepEqual(await client.health(), { healthy: true, version: "fixture" });
  const found = await client.discover();
  assert.equal(found.modelSources.checkpoints, "models-api");
  assert.deepEqual(checkCapabilities(snapshot(), found), { available: true, issues: [], integrity: "filenames-only" });
  worker.state.foldersMissing = true;
  assert.equal((await client.discover()).modelSources.checkpoints, "loader-schema");
  const missing = getModel("sdxl-base"); missing.artifacts[0].filename = "not-installed.safetensors";
  const result = checkCapabilities(compileGeneration({ modelId: missing.id, prompt: "Test" }, missing), found);
  assert.equal(result.available, false);
  assert(result.issues.some(issue => issue.code === "MISSING_MODEL"));
  assert(result.issues.some(issue => issue.code === "INVALID_NODE_INPUT"));
  delete found.objectInfo.KSampler;
  assert(checkCapabilities(snapshot(), found).issues.some(issue => issue.code === "MISSING_NODE"));
});

test("unsupported sampler is rejected by discovered schema, not a duplicated sampler list", async t => {
  const worker = await fakeComfy(); t.after(worker.close);
  const client = new ComfyClient(worker.url);
  const execution = compileGeneration({ modelId: "sdxl-base", prompt: "A cup", sampler: "unavailable_sampler" });
  assert(checkCapabilities(execution, await client.discover()).issues.some(issue => issue.message.includes("sampler_name")));
});

test("system statistics retain byte measurements and omit unrelated host metadata", async t => {
  const worker = await fakeComfy(); t.after(worker.close);
  worker.state.responseOverride = path => path === "/system_stats" ? { body: JSON.stringify({ system: { ram_total: 64 * 1024 ** 3, ram_free: 32 * 1024 ** 3, argv: ["private-path"], comfyui_version: "fixture" }, devices: [{ name: "Test GPU", type: "cuda", index: 0, vram_total: 24 * 1024 ** 3, vram_free: 22 * 1024 ** 3, torch_vram_total: 2 * 1024 ** 3, torch_vram_free: 1024 ** 3 }] }) } : undefined;
  const stats = await new ComfyClient(worker.url).systemStats();
  assert.equal(stats.devices[0].vram_total, 24 * 1024 ** 3);
  assert.equal(stats.system.ram_free, 32 * 1024 ** 3);
  assert(!("argv" in stats.system));
  assert(Number.isFinite(Date.parse(stats.sampledAt)));
  worker.state.responseOverride = path => path === "/system_stats" ? { body: JSON.stringify({ system: { ram_free: -1 }, devices: [] }) } : undefined;
  await assert.rejects(new ComfyClient(worker.url).systemStats(), { code: "INVALID_WORKER_RESPONSE" });
});

test("submits the real graph and reconciles a repeated durable ID without duplicate POST", async t => {
  const worker = await fakeComfy(); t.after(worker.close);
  const client = new ComfyClient(worker.url); const jobId = randomUUID(); const execution = snapshot();
  assert.deepEqual(await client.submit(execution, { jobId }), { promptId: jobId, reconciled: false });
  assert.deepEqual(worker.state.submissions[0].prompt, execution.graph);
  assert.equal(worker.state.submissions[0].client_id, jobId);
  assert.deepEqual(await client.submit(execution, { jobId }), { promptId: jobId, reconciled: true });
  assert.equal(worker.state.submissions.length, 1);
  assert.equal((await client.inspect(jobId)).state, "queued");
  worker.state.running = worker.state.pending.splice(0);
  assert.equal((await client.inspect(jobId)).state, "running");
  worker.state.history[jobId] = completed(worker.state.running[0]); worker.state.running = [];
  assert.equal((await client.inspect(jobId, execution)).state, "succeeded");
});

test("concurrent submission calls on one client produce one POST", async t => {
  const worker = await fakeComfy(); t.after(worker.close);
  const client = new ComfyClient(worker.url); const jobId = randomUUID();
  const results = await Promise.all([client.submit(snapshot(), { jobId }), client.submit(snapshot(), { jobId })]);
  assert.equal(results[0].promptId, results[1].promptId);
  assert.equal(worker.state.submissions.length, 1);
});

test("a durable ID cannot silently reconcile to a different snapshot", async t => {
  const worker = await fakeComfy(); t.after(worker.close);
  const client = new ComfyClient(worker.url); const jobId = randomUUID();
  await client.submit(snapshot(), { jobId });
  const different = compileGeneration({ modelId: "sdxl-base", prompt: "A different image", seed: 42 });
  await assert.rejects(client.submit(different, { jobId }), { code: "JOB_ID_CONFLICT" });
  assert.equal(worker.state.submissions.length, 1);
});

test("lost acknowledgment after acceptance is recovered by queue metadata", async t => {
  const worker = await fakeComfy(); t.after(worker.close); worker.state.postBehavior = "drop-after-accept";
  const client = new ComfyClient(worker.url); const jobId = randomUUID();
  assert.deepEqual(await client.submit(snapshot(), { jobId }), { promptId: jobId, reconciled: true });
  assert.equal(worker.state.submissions.length, 1);
});

test("uncertain unacknowledged POST is never automatically replayed", async t => {
  const worker = await fakeComfy(); t.after(worker.close); worker.state.postBehavior = "drop-before-accept";
  const client = new ComfyClient(worker.url);
  await assert.rejects(client.submit(snapshot(), { jobId: randomUUID() }), { code: "SUBMISSION_UNCERTAIN" });
  assert.equal(worker.state.submissions.length, 1);
});

test("older servers that assign IDs recover through persisted client metadata", async t => {
  const worker = await fakeComfy(); t.after(worker.close); worker.state.postBehavior = "legacy-id";
  const client = new ComfyClient(worker.url); const jobId = randomUUID();
  assert.equal((await client.submit(snapshot(), { jobId })).promptId, "legacy-prompt-id");
  worker.state.history["legacy-prompt-id"] = completed(worker.state.pending[0]); worker.state.pending = [];
  assert.deepEqual(await client.findJob(jobId), { promptId: "legacy-prompt-id", state: "succeeded" });
});

test("history is rechecked when a prompt finishes between history and queue reads", async t => {
  const worker = await fakeComfy(); t.after(worker.close); const jobId = randomUUID();
  worker.state.queueHook = () => { worker.state.history[jobId] = completed(); };
  assert.equal((await new ComfyClient(worker.url).inspect(jobId)).state, "succeeded");
});

test("output downloads are scoped to successful history and bounded before use", async t => {
  const worker = await fakeComfy(); t.after(worker.close); const jobId = randomUUID(); worker.state.history[jobId] = completed();
  const client = new ComfyClient(worker.url); const execution = snapshot();
  const output = (await client.inspect(jobId, execution)).outputs[0];
  const downloaded = await client.fetchOutput(jobId, output, execution);
  assert.equal(downloaded.mediaType, "image/png"); assert.deepEqual(downloaded.bytes, PNG);
  await assert.rejects(client.fetchOutput(jobId, { ...output, filename: "other-user.png" }, execution), { code: "INVALID_OUTPUT" });
  assert.equal(worker.state.outputReads, 1);
  worker.state.outputBytes = new Uint8Array(5000);
  await assert.rejects(new ComfyClient(worker.url, { maxOutputBytes: 1000 }).fetchOutput(jobId, output, execution), { code: "RESPONSE_TOO_LARGE" });
});

test("unsafe history paths and worker error details never become output requests", async t => {
  const worker = await fakeComfy(); t.after(worker.close); const jobId = randomUUID(); const record = completed();
  record.outputs.output.images[0].subfolder = "../other-user"; worker.state.history[jobId] = record;
  const client = new ComfyClient(worker.url);
  await assert.rejects(client.inspect(jobId), { code: "INVALID_OUTPUT" });
  assert.equal(worker.state.outputReads, 0);
  worker.state.postBehavior = "reject";
  await assert.rejects(client.submit(snapshot(), { jobId: randomUUID() }), error => {
    assert.equal((error as { code: string }).code, "WORKFLOW_REJECTED");
    assert(!String(error).includes("Private filesystem")); return true;
  });
});

test("image uploads use isolated input folders and work with loader filename selectors", async t => {
  const worker = await fakeComfy(); t.after(worker.close); const client = new ComfyClient(worker.url); const jobId = randomUUID();
  const image = await client.uploadImage(PNG, { filename: "input.png", mediaType: "image/png", jobId });
  assert.equal(image.subfolder, `grav/${jobId}`);
  assert(worker.state.uploadBody.includes('name="overwrite"\r\n\r\nfalse'));
  const execution = compileGeneration({ modelId: "sdxl-base", prompt: "Edit the image", operation: "image-to-image", images: [image] });
  assert.equal(checkCapabilities(execution, await client.discover()).available, true);
  await assert.rejects(client.uploadImage(new Uint8Array(8), { filename: "input.png", mediaType: "image/png" }), { code: "INVALID_IMAGE" });
  await assert.rejects(client.uploadImage(PNG, { filename: "../input.png", mediaType: "image/png" }), { code: "INVALID_IMAGE" });
});

test("release respects all queued work and uses /free rather than process control", async t => {
  const worker = await fakeComfy(); t.after(worker.close); const client = new ComfyClient(worker.url);
  worker.state.pending.push([1, randomUUID(), {}, {}, []]);
  assert.deepEqual(await client.freeIfIdle(), { released: false }); assert.equal(worker.state.frees, 0);
  worker.state.pending = [];
  assert.deepEqual(await client.freeIfIdle(), { released: true }); assert.equal(worker.state.frees, 1);
});

test("redirects and oversized metadata are refused", async t => {
  const worker = await fakeComfy(); t.after(worker.close);
  worker.state.responseOverride = path => path === "/system_stats" ? { status: 302, headers: { Location: "/private" }, body: "" } : undefined;
  assert.equal((await new ComfyClient(worker.url).health()).healthy, false);
  assert(!worker.state.requests.some(request => request.path === "/private"));
  worker.state.responseOverride = path => path === "/object_info" ? { headers: { "Content-Length": String(100 * 1024 * 1024) }, body: "{}" } : undefined;
  await assert.rejects(new ComfyClient(worker.url).discover(), { code: "RESPONSE_TOO_LARGE" });
});

test("WebSocket progress reports worker node counts without inventing whole-job percentages", async t => {
  const worker = await fakeComfy(); t.after(worker.close); const jobId = randomUUID();
  const events: ComfyProgress[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Missing ComfyUI progress messages")), 2000);
    const watcher = new ComfyClient(worker.url).watchProgress(jobId, event => {
      events.push(event);
      if (event.type === "completed") { clearTimeout(timer); watcher.close(); resolve(); }
    });
    t.after(() => { clearTimeout(timer); watcher.close(); });
  });
  assert.deepEqual(worker.state.websocketClients, [jobId]);
  assert.deepEqual(events, [{ type: "executing", node: "sample" }, { type: "progress", value: 3, max: 20, node: "sample" }, { type: "completed" }]);
});
