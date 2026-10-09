import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../apps/server/store.ts";
import { Engine } from "../../apps/server/engine.ts";
import { createStudioServer } from "../../apps/server/http.ts";
import { PNG } from "../inference/fake-comfy.ts";
import type { HardwareInventory } from "../../packages/hardware/src/types.ts";

const origin = "http://localhost:4321";
const hardware = (): HardwareInventory => ({ schemaVersion: 1, detectedAt: new Date().toISOString(), host: { platform: "linux", architecture: "x64", logicalCpuCount: 8, memory: { totalBytes: 64 * 1024 ** 3, availableBytes: 60 * 1024 ** 3 }, container: { detected: false, markers: [] } }, gpus: [], diagnostics: [] });
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "gravity-http-"));
  const store = new Store(directory);
  const engine = new Engine(store, { detect: async () => hardware() });
  const server = await createStudioServer({ store, engine, allowedOrigins: [origin], setupSecret: "test-setup-secret" });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await engine.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(directory, { recursive: true, force: true }); });
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
  return { store, engine, url, request, setup, cookie: () => cookie };
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
