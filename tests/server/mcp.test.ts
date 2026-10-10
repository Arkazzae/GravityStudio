import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mcpResponse, MCP_INLINE_INPUT_BYTES, type McpOptions } from "../../apps/server/mcp.ts";
import { saveInput, saveOutput } from "../../apps/server/media.ts";
import { API_SCOPES } from "../../packages/contracts/access.ts";
import { ApiError } from "../../packages/contracts/index.ts";
import { engineFixture } from "./helpers/engine-fixture.ts";
import { PNG } from "../inference/fake-comfy.ts";

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const f = await engineFixture();
  t.after(() => f.close());
  let serial = 0;
  async function rpc(method: string, params: Record<string, unknown> = {}, options: McpOptions = {}, owner = f.owner.id, modern = false) {
    const body = { jsonrpc: "2.0", id: ++serial, method, params: { ...params, ...(modern ? { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "fixture", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } : {}) } };
    const request = new Request("http://localhost/api/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": modern ? "2026-07-28" : "2025-11-25", ...(modern ? { "Mcp-Method": method, ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}) } : {}) }, body: JSON.stringify(body) });
    const response = await mcpResponse(f.engine, f.store, owner, request, body, options);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(response.headers.get("content-type")?.includes("text/event-stream") ? text.split("\n").find(line => line.startsWith("data: "))!.slice(6) : text);
  }
  const call = async (name: string, args: Record<string, unknown> = {}, options: McpOptions = {}, owner = f.owner.id) => (await rpc("tools/call", { name, arguments: args }, options, owner)).result;
  async function savedOutput() {
    const job = await f.queue();
    f.store.patchJob(job.id, { status: "preparing" });
    f.store.patchJob(job.id, { status: "running" });
    const output = await saveOutput(f.store, job.id, 0, PNG);
    f.store.patchJob(job.id, { status: "succeeded", outputs: [f.store.output(job.id, output.id, f.owner.id)] });
    return { job, output };
  }
  return { ...f, rpc, call, savedOutput };
}

test("MCP discovers only granted tools and resource templates on both protocol eras", async t => {
  const f = await fixture(t);
  const options: McpOptions = { hasScope: scope => scope === "jobs:read" };
  for (const modern of [false, true]) {
    const tools = (await f.rpc("tools/list", {}, options, f.owner.id, modern)).result.tools;
    assert.deepEqual(tools.map((tool: { name: string }) => tool.name), ["gravity_capabilities_get", "gravity_jobs_list", "gravity_job_get", "gravity_job_wait"]);
    assert.ok(tools.every((tool: { outputSchema?: unknown }) => tool.outputSchema));
    const resources = (await f.rpc("resources/templates/list", {}, options, f.owner.id, modern)).result.resourceTemplates;
    assert.deepEqual(resources.map((item: { uriTemplate: string }) => item.uriTemplate), ["gravity://jobs/{jobId}"]);
    const unavailable = await f.rpc("tools/call", { name: "gravity_input_delete", arguments: { inputId: randomUUID() } }, options, f.owner.id, modern);
    assert.ok(unavailable.error || unavailable.result?.isError);
  }
  const capabilities = (await f.call("gravity_capabilities_get", {}, options)).structuredContent.data;
  assert.equal(capabilities.uploads.inlineMaxBytes, 0);
  assert.equal(capabilities.maximumWaitSeconds, 20);
  assert.equal(capabilities.tools.includes("gravity_job_submit"), false);
});

test("MCP permissions are checked again at invocation and reference jobs require asset access", async t => {
  const f = await fixture(t);
  const result = await f.call("gravity_jobs_list", {}, { hasScope: () => true, requireScope: () => { throw new ApiError(403, "TOKEN_REVOKED", "This token was revoked."); } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.data.error.code, "TOKEN_REVOKED");
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent.data);
  let submissions = 0;
  f.engine.submit = async () => { submissions++; throw new Error("should not be called"); };
  const denied = await f.call("gravity_job_submit", { request: { modelId: "sdxl-base", prompt: "edit", images: [randomUUID()] }, idempotencyKey: "reference-permission" }, { hasScope: scope => scope === "jobs:write" });
  assert.equal(denied.structuredContent.data.error.code, "INSUFFICIENT_SCOPE");
  assert.equal(submissions, 0);
});

test("MCP output manifests, favorites and reuse preserve ownership and avoid duplicate references", async t => {
  const f = await fixture(t);
  const { job, output } = await f.savedOutput();
  const args = { jobId: job.id, outputId: output.id };
  const first = await f.call("gravity_input_from_output", args);
  const again = await f.call("gravity_input_from_output", args);
  assert.equal(first.structuredContent.data.input.id, again.structuredContent.data.input.id);
  assert.equal(f.store.inputs(f.owner.id).length, 1);
  await f.call("gravity_output_set_favorite", { ...args, favorite: true });
  const favorites = (await f.call("gravity_favorites_list")).structuredContent.data.jobs;
  assert.equal(favorites[0].outputs[0].id, output.id);
  assert.equal(favorites[0].outputs[0].favorite, true);
  const listed = (await f.call("gravity_outputs_list", { jobId: job.id })).structuredContent.data.outputs;
  assert.equal(listed.length, 1);
  assert.equal("path" in listed[0], false);
  assert.equal("object" in listed[0], false);
  const resource = await f.rpc("resources/read", { uri: `gravity://jobs/${job.id}/outputs/${output.id}` });
  assert.equal(JSON.parse(resource.result.contents[0].text).output.sha256, output.sha256);
  const stranger = randomUUID();
  for (const name of ["gravity_output_get", "gravity_output_set_favorite", "gravity_output_delete", "gravity_input_from_output"]) {
    const result = await f.call(name, { ...args, ...(name === "gravity_output_set_favorite" ? { favorite: false } : {}) }, {}, stranger);
    assert.equal(result.isError, true, name);
  }
  assert.equal(f.store.output(job.id, output.id, f.owner.id).id, output.id);
  const deniedResource = await f.rpc("resources/read", { uri: `gravity://jobs/${job.id}/outputs/${output.id}` }, {}, stranger);
  assert.ok(deniedResource.error);
});

test("MCP deletes only the requested owned image and tracks asynchronous media work", async t => {
  const f = await fixture(t);
  const { job, output } = await f.savedOutput();
  const reference = await saveInput(f.store, f.owner.id, Buffer.from(PNG), "input.png");
  let starts = 0, finishes = 0;
  const options: McpOptions = { mediaOperation: async work => { starts++; try { return await work(); } finally { finishes++; } } };
  assert.deepEqual((await f.call("gravity_input_delete", { inputId: reference.id }, options)).structuredContent.data, { deleted: true });
  const deleted = await f.call("gravity_output_delete", { jobId: job.id, outputId: output.id }, options);
  assert.equal(deleted.structuredContent.data.job.outputs.length, 0);
  assert.equal(f.store.job(job.id, f.owner.id).id, job.id);
  assert.equal(starts, 2); assert.equal(finishes, 2);
});

test("MCP wait reports timeout and interrupted work without dispatching or resubmitting", async t => {
  const f = await fixture(t);
  const job = await f.queue();
  const waited = (await f.call("gravity_job_wait", { jobId: job.id, timeoutSeconds: 1 })).structuredContent.data;
  assert.equal(waited.job.id, job.id); assert.equal(waited.timedOut, true);
  f.store.patchJob(job.id, { status: "preparing" });
  f.store.patchJob(job.id, { status: "interrupted" });
  const interrupted = (await f.call("gravity_job_wait", { jobId: job.id, timeoutSeconds: 20 })).structuredContent.data;
  assert.equal(interrupted.job.status, "interrupted"); assert.equal(interrupted.timedOut, false);
  assert.equal(f.store.jobs(f.owner.id).length, 1);
  assert.equal(f.workers[0].state.submissions.length, 0);
});

test("MCP wait rechecks access and respects cancellation", async t => {
  const f = await fixture(t);
  const job = await f.queue();
  let checks = 0;
  const result = await f.call("gravity_job_wait", { jobId: job.id, timeoutSeconds: 20 }, { requireScope: () => { if (++checks > 2) throw new ApiError(403, "TOKEN_REVOKED", "Revoked during wait."); } });
  assert.equal(result.structuredContent.data.error.code, "TOKEN_REVOKED");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20);
  try {
    const cancelled = await f.call("gravity_job_wait", { jobId: job.id }, { signal: controller.signal });
    assert.equal(cancelled.isError, true);
    assert.equal(f.store.job(job.id).status, "queued");
  } finally { clearTimeout(timeout); }
});

test("MCP sanitized system telemetry omits private addresses, identifiers and other jobs", async t => {
  const f = await fixture(t);
  await f.queue();
  const result = (await f.call("gravity_system_get")).structuredContent.data;
  assert.equal(result.gpus.length, 3);
  assert.equal(result.workers.length, 1);
  for (const field of ["jobs", "diagnostics", "deviceIds", "baseUrl", "pciAddress", "uuid", "driverVersion"]) assert.equal(JSON.stringify(result).includes(`"${field}"`), false, field);
  assert.equal((await f.call("gravity_work_time_get")).structuredContent.data.balance.userId, f.owner.id);
});

test("MCP imports bounded base64 images and rejects invalid encodings before storage", async t => {
  const f = await fixture(t);
  let uploads = 0;
  const options: McpOptions = { upload: async input => { uploads++; return saveInput(f.store, f.owner.id, Buffer.from(input.data, "base64"), input.name); } };
  const input = { name: "reference.png", mimeType: "image/png", data: Buffer.from(PNG).toString("base64"), idempotencyKey: "mcp-upload-first" };
  const saved = await f.call("gravity_input_upload", input, options);
  assert.equal(saved.structuredContent.data.input.name, "reference.png");
  assert.equal(f.store.inputs(f.owner.id).length, 1);
  for (const data of ["data:image/png;base64,AAAA", "AA?=", "AB==", "", Buffer.alloc(MCP_INLINE_INPUT_BYTES + 1).toString("base64")]) {
    const result = await f.call("gravity_input_upload", { ...input, data }, options);
    assert.equal(result.isError, true);
  }
  assert.equal(uploads, 1);
  const maximum = Buffer.alloc(MCP_INLINE_INPUT_BYTES, 1).toString("base64");
  let admitted = false;
  const accepted = await f.call("gravity_input_upload", { ...input, data: maximum }, { upload: async args => { admitted = true; assert.equal(args.data, maximum); return saved.structuredContent.data.input; } });
  assert.equal(accepted.isError, undefined);
  assert.equal(admitted, true, "The full advertised inline limit reaches the upload boundary without regex stack overflow");
});

test("MCP language tools forward function calls and refinement without mutating image jobs", async t => {
  const f = await fixture(t);
  const chatRequests: unknown[] = [], refinements: unknown[] = [];
  const options: McpOptions = {
    hasScope: scope => API_SCOPES.includes(scope),
    textModels: async () => ({ object: "list", data: [{ id: "studio-assistant", object: "model" }] }),
    chat: async body => { chatRequests.push(body); return { choices: [{ message: { role: "assistant", content: "The answer" } }] }; },
    refine: async body => { refinements.push(body); return { prompt: "Refined scene" }; },
  };
  const request = { model: "studio-assistant", messages: [{ role: "user", content: "Describe the scene" }], tools: [{ type: "function", function: { name: "scene", parameters: { type: "object", properties: { title: { type: "string" } } }, strict: true } }], tool_choice: "auto", max_completion_tokens: 100 };
  const answer = await f.call("gravity_text_chat", { request }, options);
  assert.equal(answer.structuredContent.data.choices[0].message.content, "The answer");
  assert.deepEqual(chatRequests, [{ ...request, stream: false }]);
  const body = { prompt: "A scene", imageModelId: "sdxl-base", instruction: "Make it cinematic" };
  assert.equal((await f.call("gravity_prompt_refine", body, options)).structuredContent.data.prompt, "Refined scene");
  assert.deepEqual(refinements, [body]);
  assert.equal((await f.call("gravity_text_models_list", {}, options)).structuredContent.data.data[0].id, "studio-assistant");
  assert.deepEqual(f.store.jobs(f.owner.id), []);
  const restricted = (await f.rpc("tools/list", {}, { ...options, hasScope: scope => scope !== "text:generate" })).result.tools;
  assert.equal(restricted.some((tool: { name: string }) => tool.name.startsWith("gravity_text_") || tool.name === "gravity_prompt_refine"), false);
});

test("MCP unexpected failures never expose internal exception messages", async t => {
  const f = await fixture(t);
  f.engine.catalog = async () => { throw new Error("secret filesystem path and credential"); };
  const result = await f.call("gravity_models_list");
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.data.error.code, "TOOL_FAILED");
  assert.equal(JSON.stringify(result).includes("secret filesystem"), false);
  const resource = await f.rpc("resources/read", { uri: "gravity://models/sdxl-base" });
  assert.ok(resource.error);
  assert.equal(JSON.stringify(resource).includes("secret filesystem"), false);
});
