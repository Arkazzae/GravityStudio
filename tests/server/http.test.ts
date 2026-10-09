import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../apps/server/store.ts";
import { Engine } from "../../apps/server/engine.ts";
import { createStudioServer } from "../../apps/server/http.ts";
import { saveOutput } from "../../apps/server/media.ts";
import { PNG } from "../inference/fake-comfy.ts";
import type { HardwareInventory } from "../../packages/hardware/src/types.ts";
import type { StudioSettings } from "../../packages/contracts/index.ts";
import { createRuntimeDeployment, runtimeWorkerSettings } from "../../scripts/runtime-plan.ts";
import { writeRuntimeDeployment } from "../../scripts/runtime-control.ts";
import { inventory } from "./helpers/engine-fixture.ts";

const origin = "http://localhost:4321";
const hardware = (): HardwareInventory => ({ schemaVersion: 1, detectedAt: new Date().toISOString(), host: { platform: "linux", architecture: "x64", logicalCpuCount: 8, memory: { totalBytes: 64 * 1024 ** 3, availableBytes: 60 * 1024 ** 3 }, container: { detected: false, markers: [] } }, gpus: [], diagnostics: [] });
async function fixture(t: { after: (fn: () => Promise<void>) => void }, detectedHardware = hardware()) {
  const directory = await mkdtemp(join(tmpdir(), "gravity-http-"));
  const store = new Store(directory);
  const engine = new Engine(store, { detect: async () => detectedHardware });
  const server = await createStudioServer({ store, engine, allowedOrigins: [origin], setupSecret: "test-setup-secret" });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await server.closeOperations(); await engine.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = "";
  async function request(path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) {
    const response = await fetch(`${url}/api${path}`, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0];
    return response;
  }
  async function setup() {
    const response = await request("/setup", "POST", { username: "owner", password: "test password with enough length", setupKey: "test-setup-secret" });
    assert.equal(response.status, 201); return response.json();
  }
  return { store, engine, directory, url, request, setup, cookie: () => cookie };
}

test("owner setup requires the local key and is never available a second time", async t => {
  const api = await fixture(t);
  assert.equal((await api.request("/hardware")).status, 401);
  assert.deepEqual(await (await api.request("/bootstrap")).json(), { configured: false, authenticated: false, setupRequired: true, setupKeyRequired: true });
  assert.equal((await api.request("/setup", "POST", { username: "owner", password: "test password with enough length", setupKey: "wrong" })).status, 403);
  await api.setup();
  assert.equal((await (await api.request("/bootstrap")).json()).authenticated, true);
  assert.equal((await api.request("/setup", "POST", { username: "another", password: "test password with enough length", setupKey: "test-setup-secret" })).status, 409);
  const configuration = await (await api.request("/settings")).json();
  assert.equal(configuration.revision, 0);
  assert.ok(configuration.modelConfigurations.length >= 3);
  assert.ok(configuration.modelConfigurations.every((item: { enabled: boolean }) => item.enabled === false));
  assert.deepEqual(configuration.managedWorkers, []);
});

test("browser mutations validate origins and API tokens cannot administer workers", async t => {
  const api = await fixture(t); await api.setup();
  const settings = await (await api.request("/settings")).json();
  const cross = await api.request("/settings", "PUT", settings, { Origin: "https://attacker.example" });
  assert.equal(cross.status, 403);
  const missingOrigin = await fetch(`${api.url}/api/settings`, { method: "PUT", headers: { Cookie: api.cookie(), "Content-Type": "application/json" }, body: JSON.stringify(settings) });
  assert.equal(missingOrigin.status, 403);
  const created = await (await api.request("/tokens", "POST", { name: "Test client" })).json();
  assert.match(created.token, /^gs_/);
  const bearer = { Authorization: `Bearer ${created.token}` };
  assert.equal((await fetch(`${api.url}/api/jobs`, { headers: bearer })).status, 200);
  assert.equal((await fetch(`${api.url}/api/settings`, { headers: bearer })).status, 403);
  for (const path of ["/runtime", "/models/library"]) assert.equal((await fetch(`${api.url}/api${path}`, { headers: bearer })).status, 403);
  for (const path of ["/runtime", "/models/download", "/models/activate"]) {
    assert.equal((await fetch(`${api.url}/api${path}`, { method: "POST", headers: { ...bearer, "Content-Type": "application/json" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${api.url}/api${path}`, { method: "POST", headers: { Cookie: api.cookie(), "Content-Type": "application/json" }, body: "{}" })).status, 403);
  }
  const list = await (await api.request("/tokens")).json();
  assert.equal(list.tokens.length, 1);
  assert.equal("hash" in list.tokens[0], false);
  assert.equal("token" in list.tokens[0], false);
  assert.equal((await api.request(`/tokens/${created.id}`, "DELETE")).status, 200);
  assert.equal((await fetch(`${api.url}/api/jobs`, { headers: bearer })).status, 401);
});

test("settings saves are versioned and reject unsupported hardware assignments", async t => {
  const api = await fixture(t); await api.setup();
  const settings = await (await api.request("/settings")).json();
  const saved = await api.request("/settings", "PUT", settings);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 1);
  assert.equal((await api.request("/settings", "PUT", settings)).status, 409);
  const bad = { ...settings, revision: 1, workers: [{ id: "gpu", name: "Missing GPU", enabled: true, baseUrl: "http://127.0.0.1:8188", location: "local", deviceIds: ["nvidia:missing"] }] };
  const rejected = await api.request("/settings", "PUT", bad);
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error.message, /no longer available/);
  assert.equal((await api.request("/workers/probe", "POST", { baseUrl: "http://169.254.169.254/" })).status, 400);
});

test("settings expose real managed bindings and reject reconfiguration without writing or probing", async t => {
  const detected = inventory();
  detected.gpus.forEach((gpu, index) => { gpu.uuid = `GPU-aaaaaaaa-bbbb-cccc-dddd-${String(index).padStart(12, "0")}`; gpu.driverVersion = "580.100.00"; });
  const api = await fixture(t, detected); await api.setup();
  const plan = createRuntimeDeployment(detected, { dataDirectory: api.directory, engine: "docker", gpuIds: detected.gpus.slice(0, 2).map(gpu => gpu.id) });
  await writeRuntimeDeployment(plan);
  const initial = api.store.settings();
  initial.workers = runtimeWorkerSettings(plan).map((worker, index) => ({ ...worker, enabled: index === 0 }));
  initial.workers.push({ id: "managed-manual", name: "External ComfyUI", baseUrl: "http://127.0.0.1:9999", enabled: false, location: "remote", deviceIds: [], maxConcurrentJobs: 1 });
  api.store.saveSettings(initial);
  let invalidated = 0, refreshed = 0;
  api.engine.invalidateWorkers = () => { invalidated++; };
  api.engine.refreshWorkers = async () => { refreshed++; };
  const expected = plan.workers.map(worker => ({ id: worker.id, baseUrl: worker.baseUrl, deviceId: worker.gpuId }));
  const view = await (await api.request("/settings")).json();
  assert.deepEqual(view.managedWorkers, expected);
  const before = api.store.settings();
  const mutations: Array<[string, (settings: StudioSettings) => void]> = [
    ["id", settings => { settings.workers[0].id = "renamed-managed-id"; }],
    ["endpoint", settings => { settings.workers[0].baseUrl = "http://127.0.0.1:9998"; }],
    ["location", settings => { settings.workers[0].location = "remote"; }],
    ["GPU", settings => { settings.workers[0].deviceIds = [detected.gpus[1].id]; }],
    ["enabled", settings => { settings.workers[0].enabled = false; }],
    ["disabled worker enabled", settings => { settings.workers[1].enabled = true; }],
    ["removal", settings => { settings.workers.splice(0, 1); }],
    ["disabled removal", settings => { settings.workers.splice(1, 1); }],
    ["identity and endpoint replacement", settings => { settings.workers[0].id = "manual-replacement"; settings.workers[0].baseUrl = "http://127.0.0.1:9998"; }],
  ];
  for (const [name, mutate] of mutations) {
    const proposed = structuredClone(view);
    mutate(proposed);
    proposed.managedWorkers = [];
    proposed.policy.maxConcurrentJobs = 2;
    const response = await api.request("/settings", "PUT", proposed);
    assert.equal(response.status, 409, name);
    const body = await response.json();
    assert.equal(body.error.code, "MANAGED_WORKER_LOCKED", name);
    assert.match(body.error.message, /Settings → GPUs/);
    assert.deepEqual(api.store.settings(), before, name);
    assert.equal(api.store.metadata("runtime-auto-concurrency"), undefined, name);
  }
  assert.equal(invalidated, 0);
  assert.equal(refreshed, 0);

  const allowed = structuredClone(view);
  allowed.workers[0].name = "Front GPU";
  allowed.workers[2] = { ...allowed.workers[2], id: "manual-updated", name: "Remote GPU", baseUrl: "http://127.0.0.1:9997", enabled: true, deviceIds: ["remote-card"] };
  allowed.policy.maxConcurrentJobs = 2;
  allowed.managedWorkers = [{ id: "manual-updated", baseUrl: "http://127.0.0.1:9997", deviceId: "forged" }];
  const response = await api.request("/settings", "PUT", allowed);
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.deepEqual(saved.managedWorkers, expected);
  assert.equal(saved.workers[0].name, "Front GPU");
  assert.equal(saved.workers[2].enabled, true);
  assert.equal(saved.policy.maxConcurrentJobs, 2);
  assert.equal(api.store.metadata("runtime-auto-concurrency"), false);
  assert.equal("managedWorkers" in api.store.settings(), false);
  assert.equal(invalidated, 1);
  assert.equal(refreshed, 1);

  saved.workers.splice(2, 1);
  assert.equal((await api.request("/settings", "PUT", saved)).status, 200, "manual workers remain removable");
});

test("planned worker identities cannot be spoofed before registration and unreadable plans fail closed", async t => {
  const detected = inventory();
  detected.gpus.forEach((gpu, index) => { gpu.uuid = `GPU-aaaaaaaa-bbbb-cccc-dddd-${String(index).padStart(12, "0")}`; gpu.driverVersion = "580.100.00"; });
  const api = await fixture(t, detected); await api.setup();
  const plan = createRuntimeDeployment(detected, { dataDirectory: api.directory, engine: "docker", gpuIds: [detected.gpus[0].id] });
  await writeRuntimeDeployment(plan);
  const initial = await (await api.request("/settings")).json();
  initial.workers = runtimeWorkerSettings(plan);
  initial.managedWorkers = [];
  assert.equal((await api.request("/settings", "PUT", initial)).status, 409);
  assert.equal(api.store.settings().revision, 0);
  assert.deepEqual(api.store.settings().workers, []);

  await writeFile(join(api.directory, "runtime", "plan.json"), "{broken JSON");
  assert.equal((await api.request("/settings")).status, 500);
  assert.equal((await api.request("/settings", "PUT", initial)).status, 500);
  assert.equal(api.store.settings().revision, 0);
  await rm(join(api.directory, "runtime", "plan.json"));
  await mkdir(join(api.directory, "runtime", "plan.json"));
  assert.equal((await api.request("/settings", "PUT", initial)).status, 500, "read errors must not unlock planned bindings");
  assert.equal(api.store.settings().revision, 0);
});

test("reference uploads validate image bytes and require ownership to read", async t => {
  const api = await fixture(t); await api.setup();
  const headers = { Origin: origin, Cookie: api.cookie(), "Content-Type": "image/png", "X-Filename": "reference.png" };
  const upload = await fetch(`${api.url}/api/inputs`, { method: "POST", headers, body: PNG });
  assert.equal(upload.status, 201);
  const image = await upload.json();
  assert.equal(image.width, 1);
  assert.equal(image.height, 1);
  assert.equal("path" in image, false);
  const downloaded = await fetch(`${api.url}${image.url}`, { headers: { Cookie: api.cookie() } });
  assert.equal(downloaded.headers.get("content-type"), "image/png");
  assert.ok((await downloaded.arrayBuffer()).byteLength > 0);
  assert.equal((await fetch(`${api.url}${image.url}`)).status, 401);
  assert.equal((await fetch(`${api.url}/api/inputs`, { method: "POST", headers, body: "not an image" })).status, 400);
});

test("favorite routes validate mutations and expose only the owner's selected generated images", async t => {
  const api = await fixture(t);
  assert.equal((await api.request("/favorites")).status, 401);
  await api.setup();
  const owner = api.store.owner()!;
  const job = api.store.createJob(owner.id, { modelId: "sdxl-base", prompt: "A cup" }, { immutable: true }, [], "SDXL", {}, "favorite-output", "favorite-output");
  const outputs = [await saveOutput(api.store, job.id, 0, PNG), await saveOutput(api.store, job.id, 1, PNG)];
  api.store.patchJob(job.id, { status: "preparing" });
  api.store.patchJob(job.id, { status: "succeeded", outputs });
  const path = `/jobs/${job.id}/outputs/${outputs[0].id}/favorite`;
  const original = api.store.job(job.id);
  assert.deepEqual(await (await api.request("/favorites")).json(), { jobs: [] });
  assert.equal((await fetch(`${api.url}/api${path}`, { method: "PUT", headers: { Cookie: api.cookie(), "Content-Type": "application/json" }, body: '{"favorite":true}' })).status, 403);
  assert.equal((await api.request(path, "PUT", { favorite: true }, { Origin: "https://attacker.example" })).status, 403);
  for (const body of [{}, { favorite: "true" }, { favorite: 1 }, { favorite: true, userId: "another-owner" }]) {
    const response = await api.request(path, "PUT", body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_FAVORITE");
  }
  assert.equal((await api.request(`/jobs/${job.id}/outputs/${"0".repeat(32)}/favorite`, "PUT", { favorite: true })).status, 404);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await api.request(path, "PUT", { favorite: true });
    assert.equal(response.status, 200);
    const saved = (await response.json()).job;
    assert.deepEqual(saved.outputs.map((output: { favorite: boolean }) => output.favorite), [true, false]);
    assert.equal(saved.updatedAt, original.updatedAt);
    assert.equal("snapshot" in saved, false);
    assert.equal("path" in saved.outputs[0], false);
  }
  for (const endpoint of ["/jobs", "/state"]) {
    const response = await (await api.request(endpoint)).json();
    assert.deepEqual(response.jobs[0].outputs.map((output: { favorite: boolean }) => output.favorite), [true, false]);
  }
  const favorites = await (await api.request("/favorites")).json();
  assert.equal(favorites.jobs.length, 1);
  assert.deepEqual(favorites.jobs[0].outputs.map((output: { id: string }) => output.id), [outputs[0].id]);

  api.store.db.prepare("INSERT INTO users VALUES(?,?,?,?)").run("foreign-owner", "foreign", "fixture-hash", new Date().toISOString());
  const foreign = api.store.createJob("foreign-owner", { modelId: "sdxl-base", prompt: "Private image" }, {}, [], "SDXL", {}, "foreign-job", "foreign-job");
  const privateOutput = await saveOutput(api.store, foreign.id, 0, PNG);
  api.store.patchJob(foreign.id, { status: "preparing" });
  api.store.patchJob(foreign.id, { status: "succeeded", outputs: [privateOutput] });
  api.store.setOutputFavorite(foreign.id, privateOutput.id, "foreign-owner", true);
  assert.equal((await api.request(`/jobs/${foreign.id}/outputs/${privateOutput.id}/favorite`, "PUT", { favorite: false })).status, 404);
  assert.equal((await api.request(`/jobs/${job.id}/outputs/${privateOutput.id}/favorite`, "PUT", { favorite: true })).status, 404);
  assert.deepEqual((await (await api.request("/favorites")).json()).jobs.map((item: { id: string }) => item.id), [job.id]);
  assert.equal((await api.request(path, "PUT", { favorite: false })).status, 200);
  assert.deepEqual(await (await api.request("/favorites")).json(), { jobs: [] });
  assert.equal(api.store.favorites("foreign-owner").length, 1);
});

test("output deletion is owner scoped, protects active jobs and removes one image from every projection", async t => {
  const api = await fixture(t);
  await api.setup();
  const owner = api.store.owner()!;
  const job = api.store.createJob(owner.id, { modelId: "sdxl-base", prompt: "Two images" }, { immutable: true }, [], "SDXL", { seed: 31 }, "delete-output", "delete-output");
  const outputs = [await saveOutput(api.store, job.id, 0, PNG), await saveOutput(api.store, job.id, 1, PNG)];
  api.store.patchJob(job.id, { outputs });
  const paths = outputs.map(output => `/jobs/${job.id}/outputs/${output.id}`);
  const files = outputs.map(output => api.store.output(job.id, output.id, owner.id).path);
  assert.equal((await fetch(`${api.url}/api${paths[0]}`, { method: "DELETE", headers: { Origin: origin } })).status, 401);
  assert.equal((await fetch(`${api.url}/api${paths[0]}`, { method: "DELETE", headers: { Cookie: api.cookie() } })).status, 403);
  assert.equal((await api.request(paths[0], "DELETE", undefined, { Origin: "https://attacker.example" })).status, 403);
  assert.equal((await api.request(`/jobs/${job.id}/outputs/${"0".repeat(32)}`, "DELETE")).status, 404);
  for (const status of ["queued", "preparing", "running", "interrupted"] as const) {
    api.store.patchJob(job.id, { status });
    const response = await api.request(paths[0], "DELETE");
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "JOB_ACTIVE");
    assert.equal(api.store.job(job.id).outputs.length, 2);
    assert.deepEqual(await readFile(files[0]), Buffer.from(PNG));
  }
  assert.deepEqual(api.store.pendingOutputDeletions(), []);
  api.store.patchJob(job.id, { status: "failed" });
  outputs.forEach(output => api.store.setOutputFavorite(job.id, output.id, owner.id, true));
  const original = api.store.job(job.id);

  api.store.db.prepare("INSERT INTO users VALUES(?,?,?,?)").run("foreign-owner", "foreign", "fixture-hash", new Date().toISOString());
  const foreign = api.store.createJob("foreign-owner", { modelId: "sdxl-base", prompt: "Private image" }, {}, [], "SDXL", {}, "foreign-delete", "foreign-delete");
  const privateOutput = await saveOutput(api.store, foreign.id, 0, PNG);
  api.store.patchJob(foreign.id, { status: "cancelled", outputs: [privateOutput] });
  api.store.setOutputFavorite(foreign.id, privateOutput.id, "foreign-owner", true);
  assert.equal((await api.request(`/jobs/${foreign.id}/outputs/${privateOutput.id}`, "DELETE")).status, 404);
  assert.equal((await api.request(`/jobs/${job.id}/outputs/${privateOutput.id}`, "DELETE")).status, 404);
  assert.deepEqual(await readFile(api.store.output(foreign.id, privateOutput.id, "foreign-owner").path), Buffer.from(PNG));

  const response = await api.request(paths[0], "DELETE");
  assert.equal(response.status, 200);
  const deleted = (await response.json()).job;
  assert.deepEqual(deleted.outputs.map((output: { id: string }) => output.id), [outputs[1].id]);
  assert.equal("snapshot" in deleted, false);
  assert.equal("path" in deleted.outputs[0], false);
  assert.deepEqual(api.store.job(job.id), { ...original, outputs: [original.outputs[1]] });
  await assert.rejects(readFile(files[0]), { code: "ENOENT" });
  assert.deepEqual(await readFile(files[1]), Buffer.from(PNG));
  for (const endpoint of ["/state", "/jobs", "/favorites"]) {
    const view = await (await api.request(endpoint)).json();
    assert.deepEqual(view.jobs.flatMap((item: { outputs: Array<{ id: string }> }) => item.outputs.map(output => output.id)), [outputs[1].id]);
  }
  assert.equal((await api.request(paths[0])).status, 404);
  assert.equal((await api.request(`${paths[0]}/favorite`, "PUT", { favorite: true })).status, 404);
  assert.equal((await api.request(paths[0], "DELETE")).status, 404);
  assert.equal((await api.request(paths[1], "DELETE")).status, 200);
  assert.deepEqual((await (await api.request(`/jobs/${job.id}`)).json()).job.outputs, []);
  assert.deepEqual(await (await api.request("/favorites")).json(), { jobs: [] });
  assert.equal(api.store.favorites("foreign-owner").length, 1);
});

test("concurrent output deletions preserve siblings and a pending deletion cannot be favorited", async t => {
  const api = await fixture(t); await api.setup();
  const owner = api.store.owner()!;
  const job = api.store.createJob(owner.id, { modelId: "sdxl-base", prompt: "Three images" }, { immutable: true }, [], "SDXL", {}, "concurrent-delete", "concurrent-delete");
  const outputs = await Promise.all([0, 1, 2].map(index => saveOutput(api.store, job.id, index, PNG)));
  api.store.patchJob(job.id, { status: "preparing" });
  api.store.patchJob(job.id, { status: "succeeded", outputs });
  outputs.forEach(output => api.store.setOutputFavorite(job.id, output.id, owner.id, true));
  const original = api.store.job(job.id);
  api.store.beginOutputDeletion(job.id, outputs[0].id, owner.id);
  const favorite = await api.request(`/jobs/${job.id}/outputs/${outputs[0].id}/favorite`, "PUT", { favorite: false });
  assert.equal(favorite.status, 409);
  assert.equal((await favorite.json()).error.code, "OUTPUT_DELETION_PENDING");
  const results = await Promise.all([0, 0, 1].map(index => api.request(`/jobs/${job.id}/outputs/${outputs[index].id}`, "DELETE")));
  assert.equal(results[0].status, 200);
  assert.ok([200, 404].includes(results[1].status));
  assert.equal(results[2].status, 200);
  assert.deepEqual(api.store.job(job.id), { ...original, outputs: [original.outputs[2]] });
  assert.deepEqual(api.store.favorites(owner.id)[0].outputs.map(output => output.id), [outputs[2].id]);
  assert.deepEqual(api.store.pendingOutputDeletions(), []);
});

test("generation requires an idempotency key and logout invalidates the session", async t => {
  const api = await fixture(t); await api.setup();
  assert.equal((await api.request("/jobs", "POST", { modelId: "sdxl-base", prompt: "mountain" })).status, 400);
  const request = await api.request("/jobs", "POST", { modelId: "sdxl-base", prompt: "mountain" }, { "Idempotency-Key": "request-first" });
  assert.equal(request.status, 400);
  assert.equal((await request.json()).error.code, "MODEL_DISABLED");
  const oldCookie = api.cookie();
  await api.request("/logout", "POST", {});
  assert.equal((await fetch(`${api.url}/api/jobs`, { headers: { Cookie: oldCookie } })).status, 401);
});

test("MCP authenticates every request and exposes generation tools without server administration", async t => {
  const api = await fixture(t); await api.setup();
  const created = await (await api.request("/tokens", "POST", { name: "MCP client" })).json();
  const headers = { Authorization: `Bearer ${created.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const rpc = (body: unknown, extra: Record<string, string> = {}) => fetch(`${api.url}/api/mcp`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  async function message(response: Response) {
    const text = await response.text();
    if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
      const data = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
      assert.equal(data.length, 1); return data[0];
    }
    return JSON.parse(text);
  }
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" } } };
  assert.equal((await rpc(init, { Authorization: "Bearer invalid" })).status, 401);
  const initialized = await rpc(init);
  assert.equal(initialized.status, 200);
  assert.equal((await message(initialized)).result.serverInfo.name, "gravity-studio");
  const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(listed.status, 200);
  const names = (await message(listed)).result.tools.map((tool: { name: string }) => tool.name).sort();
  assert.deepEqual(names, ["gravity_inputs_list", "gravity_job_cancel", "gravity_job_get", "gravity_job_submit", "gravity_jobs_list", "gravity_models_list"]);
  const result = await message(await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "gravity_jobs_list", arguments: {} } }));
  assert.deepEqual(result.result.structuredContent.data, { jobs: [] });
  const rejected = await message(await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "gravity_job_submit", arguments: { request: { modelId: "sdxl-base", prompt: "mountain" }, idempotencyKey: "mcp-request-first" } } }));
  assert.equal(rejected.result.isError, true);
  assert.equal(JSON.parse(rejected.result.content[0].text).error.code, "MODEL_DISABLED");
  await api.request(`/tokens/${created.id}`, "DELETE");
  assert.equal((await rpc(init)).status, 401);
});
