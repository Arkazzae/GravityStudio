import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../apps/server/store.ts";
import { Engine } from "../../apps/server/engine.ts";
import { createStudioServer } from "../../apps/server/http.ts";
import { CredentialVault } from "../../apps/server/credentials.ts";

const origin = "http://localhost:4321";
const secret = "fixture-provider-secret-1234";
async function fixture(t: TestContext, integrationFetch: typeof fetch = async () => new Response(null)) {
  const directory = await mkdtemp(join(tmpdir(), "gravity-integrations-http-"));
  const store = new Store(directory);
  const engine = new Engine(store);
  const server = await createStudioServer({ store, engine, allowedOrigins: [origin], setupSecret: "fixture-setup", integrationFetch });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await server.closeOperations(); await engine.stop(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = "";
  async function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
    return fetch(`${url}/api${path}`, { method, headers: { Origin: origin, Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function setup() {
    const response = await request("/setup", "POST", { username: "owner", password: "fixture owner password", setupKey: "fixture-setup" });
    assert.equal(response.status, 201);
    cookie = response.headers.get("set-cookie")!.split(";")[0];
  }
  return { store, url, request, setup, cookie: () => cookie };
}

test("integration keys require an owner session and allowed mutation origin", async t => {
  let contacted = 0;
  const api = await fixture(t, async () => { contacted++; return new Response(null); });
  assert.equal((await api.request("/integrations")).status, 401);
  assert.equal((await api.request("/integrations/openai", "PUT", { apiKey: secret })).status, 401);
  await api.setup();
  const token = await (await api.request("/tokens", "POST", { name: "Inference client" })).json();
  const operations = [["/integrations", "GET"], ["/integrations/openai", "PUT"], ["/integrations/openai", "DELETE"], ["/integrations/openai/test", "POST"]];
  for (const [path, method] of operations) {
    const response = await fetch(`${api.url}/api${path}`, { method, headers: { Authorization: `Bearer ${token.token}`, ...(["PUT", "POST"].includes(method) ? { "Content-Type": "application/json" } : {}) }, ...(["PUT", "POST"].includes(method) ? { body: "{}" } : {}) });
    assert.equal(response.status, 403, `${method} ${path} must reject bearer tokens`);
  }
  for (const method of ["PUT", "DELETE", "POST"]) {
    const path = method === "POST" ? "/integrations/openai/test" : "/integrations/openai";
    assert.equal((await api.request(path, method, {}, { Origin: "https://attacker.example" })).status, 403);
    assert.equal((await fetch(`${api.url}/api${path}`, { method, headers: { Cookie: api.cookie(), "Content-Type": "application/json" }, body: "{}" })).status, 403);
  }
  assert.equal(contacted, 0);
});

test("all six credentials save and replace without revealing secrets in public responses or settings", async t => {
  let contacted = 0;
  const api = await fixture(t, async () => { contacted++; return new Response(null); }); await api.setup();
  const initial = await api.request("/integrations");
  assert.equal(initial.headers.get("cache-control"), "private, no-store");
  const providers = (await initial.json()).providers;
  assert.deepEqual(providers.map((provider: { id: string }) => provider.id), ["huggingface", "civitai", "gemini", "openai", "anthropic", "nanogpt"]);
  assert.ok(providers.every((provider: { credential: unknown }) => provider.credential === null));
  for (const { id } of providers) {
    const response = await api.request(`/integrations/${id}`, "PUT", { apiKey: `  ${secret}  ` });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes(secret), false);
    const saved = JSON.parse(text);
    assert.deepEqual(Object.keys(saved.credential).sort(), ["suffix", "updatedAt"]);
    assert.equal(saved.credential.suffix, "1234");
    assert.equal(new CredentialVault(api.store).get(id), secret);
  }
  assert.equal(contacted, 0, "saving a key must not contact providers");
  const replacement = await api.request("/integrations/openai", "PUT", { apiKey: "fixture-replacement-5678" });
  assert.equal((await replacement.json()).credential.suffix, "5678");
  const listing = await (await api.request("/integrations")).text();
  assert.equal(listing.includes(secret), false);
  assert.equal(listing.includes("fixture-replacement"), false);
  const settings = await (await api.request("/settings")).text();
  assert.equal(settings.includes("credential"), false);
  assert.equal(settings.includes(secret), false);
  assert.equal((await api.request("/integrations/openai", "DELETE")).status, 200);
  assert.equal((await (await api.request("/integrations/openai", "DELETE")).json()).credential, null);
  assert.equal((await api.request("/integrations/openai/test", "POST", {})).status, 409);
});

test("integration validation preserves saved credentials and never contacts arbitrary providers", async t => {
  let contacted = 0;
  const api = await fixture(t, async () => { contacted++; return new Response(null); }); await api.setup();
  await api.request("/integrations/openai", "PUT", { apiKey: secret });
  for (const body of [{}, { apiKey: "" }, { apiKey: "1234567" }, { apiKey: null }, { apiKey: "fixture key with spaces" }, { apiKey: "x".repeat(4097) }, { apiKey: secret, baseUrl: "https://attacker.example" }]) {
    assert.equal((await api.request("/integrations/openai", "PUT", body)).status, 400);
    assert.equal(new CredentialVault(api.store).get("openai"), secret);
  }
  assert.equal((await api.request("/integrations/unknown", "PUT", { apiKey: secret })).status, 404);
  assert.equal((await api.request("/integrations/openai/test", "POST", { apiKey: secret })).status, 400);
  assert.equal(contacted, 0);
});

test("access checks use only the saved secret and sanitize upstream failures without deleting it", async t => {
  let deny = false;
  const api = await fixture(t, async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/models");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
    assert.equal(init?.redirect, "error");
    return new Response(deny ? `upstream leaked ${secret}` : null, { status: deny ? 401 : 200 });
  }); await api.setup();
  await api.request("/integrations/openai", "PUT", { apiKey: secret });
  const checked = await api.request("/integrations/openai/test", "POST", {});
  assert.equal(checked.status, 200); assert.equal((await checked.json()).ok, true);
  deny = true;
  const failed = await api.request("/integrations/openai/test", "POST", {});
  assert.equal(failed.status, 400);
  assert.equal((await failed.text()).includes(secret), false);
  assert.equal(new CredentialVault(api.store).get("openai"), secret);
});

test("parallel checks are bounded and replacing a key invalidates a pending check", async t => {
  let finish!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const api = await fixture(t, async () => { started(); await waiting; return new Response(null); }); await api.setup();
  try {
    await api.request("/integrations/openai", "PUT", { apiKey: secret });
    const pending = api.request("/integrations/openai/test", "POST", {});
    await entered;
    assert.equal((await api.request("/integrations/openai/test", "POST", {})).status, 409);
    assert.equal((await api.request("/integrations/openai", "PUT", { apiKey: "fixture-replaced-5678" })).status, 200);
    finish();
    const result = await pending;
    assert.equal(result.status, 409);
    assert.equal((await result.json()).error.code, "INTEGRATION_KEY_CHANGED");
    assert.equal((await api.request("/integrations/openai/test", "POST", {})).status, 200);
  } finally { finish(); }
});
