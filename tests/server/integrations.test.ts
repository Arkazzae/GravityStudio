import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, type IntegrationProviderId } from "../../packages/contracts/index.ts";
import { INTEGRATION_PROVIDERS, integrationProvider, testIntegration } from "../../apps/server/integrations.ts";

const key = "test-only-credential-never-return-this";
const checks: { id: IntegrationProviderId; url: string; header: string; credential: string }[] = [
  { id: "huggingface", url: "https://huggingface.co/api/whoami-v2", header: "Authorization", credential: `Bearer ${key}` },
  { id: "civitai", url: "https://civitai.com/api/v1/me", header: "Authorization", credential: `Bearer ${key}` },
  { id: "gemini", url: "https://generativelanguage.googleapis.com/v1beta/models", header: "x-goog-api-key", credential: key },
  { id: "openai", url: "https://api.openai.com/v1/models", header: "Authorization", credential: `Bearer ${key}` },
  { id: "anthropic", url: "https://api.anthropic.com/v1/models", header: "x-api-key", credential: key },
  { id: "nanogpt", url: "https://api.nano-gpt.com/api/v1/usage", header: "Authorization", credential: `Bearer ${key}` },
];

test("only fixed provider IDs can select an integration", async () => {
  assert.deepEqual(INTEGRATION_PROVIDERS.map(provider => provider.id), checks.map(check => check.id));
  for (const check of checks) assert.equal(integrationProvider(check.id), check.id);
  for (const invalid of ["", "__proto__", "constructor", "openai?token=secret", "https://attacker.invalid/"]) {
    assert.throws(() => integrationProvider(invalid), (error: unknown) => error instanceof ApiError && error.status === 404 && (!invalid || !error.message.includes(invalid)));
  }
  let fetched = false;
  await assert.rejects(testIntegration("https://attacker.invalid/" as IntegrationProviderId, key, async () => { fetched = true; return new Response(); }), { code: "INTEGRATION_NOT_FOUND" });
  assert.equal(fetched, false);
  assert.equal(JSON.stringify(INTEGRATION_PROVIDERS).includes(key), false);
});

for (const check of checks) {
  test(`${check.id} verifies a key using a free authenticated endpoint without following redirects`, async () => {
    let calls = 0;
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const result = await testIntegration(check.id, key, async (input, init) => {
      calls += 1;
      assert.equal(input, check.url);
      const url = new URL(String(input));
      assert.equal(url.protocol, "https:");
      assert.equal(url.search, "");
      assert.equal(String(input).includes(key), false);
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal instanceof AbortSignal);
      assert.equal(init.signal.aborted, false);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get(check.header), check.credential);
      assert.equal(headers.get("Accept"), "application/json");
      assert.equal(headers.get("anthropic-version"), check.id === "anthropic" ? "2023-06-01" : null);
      return new Response(body);
    });
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes(key), false);
  });
}

test("provider failures return safe errors without exposing upstream details or logging out the owner", async () => {
  const cases = [
    { status: 401, code: "INTEGRATION_AUTH_FAILED", publicStatus: 400 },
    { status: 403, code: "INTEGRATION_ACCESS_DENIED", publicStatus: 400 },
    { status: 429, code: "INTEGRATION_RATE_LIMITED", publicStatus: 429 },
    { status: 302, code: "INTEGRATION_UNAVAILABLE", publicStatus: 502 },
    { status: 404, code: "INTEGRATION_UNAVAILABLE", publicStatus: 502 },
    { status: 500, code: "INTEGRATION_UNAVAILABLE", publicStatus: 502 },
  ];
  for (const { status, code, publicStatus } of cases) {
    const upstream = `${key} reflected error from https://upstream.invalid/private-account`;
    let response: Response | undefined;
    await assert.rejects(testIntegration("openai", key, async () => {
      response = new Response(upstream, { status, statusText: key, headers: { Location: "https://attacker.invalid/", "x-private-error": key } });
      return response;
    }), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, publicStatus);
      assert.equal(error.code, code);
      assert.equal(error.message.includes(key), false);
      assert.equal(error.message.includes("https://"), false);
      assert.equal(JSON.stringify(error).includes(upstream), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(response?.bodyUsed, true, "upstream body is discarded");
  }
});

test("network and redirect exceptions cannot leak credentials through messages or causes", async () => {
  for (const thrown of [new Error(`${key} at https://attacker.invalid/`), new ApiError(500, key, key), key]) {
    await assert.rejects(testIntegration("gemini", key, async () => { throw thrown; }), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 502);
      assert.equal(error.code, "INTEGRATION_UNAVAILABLE");
      assert.equal(String(error).includes(key), false);
      assert.equal(JSON.stringify(error).includes(key), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("a hung provider is aborted within eight seconds and the timeout error is sanitized", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  let settled = false;
  const pending = testIntegration("anthropic", key, async (_input, init) => {
    signal = init?.signal ?? undefined;
    return await new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error(key)), { once: true }));
  });
  const rejected = assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 504);
    assert.equal(error.code, "INTEGRATION_TIMEOUT");
    assert.equal(String(error).includes(key), false);
    settled = true;
    return true;
  });
  t.mock.timers.tick(7999);
  assert.equal(signal?.aborted, false);
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.equal(signal?.aborted, true);
  await rejected;
});

test("completed probes clear the timeout without aborting a later request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  await testIntegration("huggingface", key, async (_input, init) => { signal = init?.signal ?? undefined; return new Response(); });
  t.mock.timers.tick(10000);
  assert.equal(signal?.aborted, false);
});
