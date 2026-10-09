import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../apps/server/store.ts";
import { CredentialVault } from "../../apps/server/credentials.ts";
import { TextService, textBaseUrl } from "../../apps/server/text.ts";

const secret = "fixture-text-secret-1234";
const list = () => Response.json({ data: [{ id: "local-chat" }] });
const completion = (prompt = "A ceramic cup on a wooden table.") => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ prompt }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
const geminiList = () => Response.json({ models: [{ name: "models/gemini-test-flash", displayName: "Test Flash", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 32000, outputTokenLimit: 8192 }] });
const geminiCompletion = () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ prompt: "A ceramic cup on a wooden table." }) }] } }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 18 } });
async function fixture(t: TestContext, fetcher: typeof fetch = async input => String(input).includes("/models") ? list() : completion(), timeoutMs?: number) {
  const directory = await mkdtemp(join(tmpdir(), "gravity-text-"));
  const store = new Store(directory);
  const master = randomBytes(32).toString("base64");
  const credentials = new CredentialVault(store, { key: master });
  const service = new TextService(store, credentials, { fetch: fetcher, timeoutMs });
  t.after(async () => { await service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const connect = async () => {
    service.saveConnection({ revision: service.settings().revision, baseUrl: "http://127.0.0.1:8080/v1", apiKey: secret });
    return service.saveAssistant({ revision: service.settings().revision, provider: "openai-compatible", modelId: "local-chat" });
  };
  const input = () => ({ settingsRevision: service.settings().revision, imageModelId: "sdxl-base", prompt: "A ceramic cup." });
  return { directory, store, credentials, service, master, connect, input };
}

test("text settings persist separately from image settings and encrypt the compatible key", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.service.settings(), { revision: 0, connection: { baseUrl: "", credential: null }, assistant: null });
  const imageSettings = f.store.settings();
  await f.connect();
  assert.equal(f.service.settings().connection.credential!.suffix, "1234");
  assert.equal(JSON.stringify(f.service.settings()).includes(secret), false);
  assert.deepEqual(f.store.settings(), imageSettings);
  assert.equal(f.credentials.get("openai"), undefined, "the generic provider key is a different credential");
  assert.equal((await readFile(join(f.directory, "studio.sqlite"))).includes(Buffer.from(secret)), false);
  const reopened = new Store(f.directory);
  const restored = new TextService(reopened, new CredentialVault(reopened, { key: f.master }));
  try { assert.deepEqual(restored.settings(), f.service.settings()); }
  finally { await restored.close(); reopened.close(); }
});

test("changing a destination clears its key and selected assistant; stale and invalid saves are atomic", async t => {
  const f = await fixture(t); await f.connect();
  const before = f.service.settings();
  assert.throws(() => f.service.saveConnection({ revision: 0, baseUrl: "https://other.example/v1", apiKey: "another-secret-key" }), { code: "TEXT_SETTINGS_CHANGED" });
  assert.throws(() => f.service.saveConnection({ revision: before.revision, baseUrl: "https://other.example/v1", apiKey: "short" }), { code: "INVALID_API_KEY" });
  assert.deepEqual(f.service.settings(), before);
  assert.equal(f.credentials.get("text-openai-compatible"), secret);
  const normalized = f.service.saveConnection({ revision: before.revision, baseUrl: `${before.connection.baseUrl}/` });
  assert.equal(normalized.connection.credential!.suffix, "1234", "the same normalized destination retains its key");
  const moved = f.service.saveConnection({ revision: normalized.revision, baseUrl: "https://other.example/v1" });
  assert.equal(moved.connection.credential, null); assert.equal(moved.assistant, null);
  const replaced = f.service.saveConnection({ revision: moved.revision, baseUrl: "https://third.example/v1", apiKey: "replacement-secret-5678" });
  assert.equal(replaced.connection.credential!.suffix, "5678");
  const removed = f.service.saveConnection({ revision: replaced.revision, baseUrl: "" });
  assert.equal(removed.connection.baseUrl, ""); assert.equal(removed.connection.credential, null);
});

test("configured endpoints accept local servers and reject credentials, metadata and malformed destinations", () => {
  for (const url of ["http://localhost:8080/v1", "http://ubuntullm:8080/v1", "http://192.168.1.20:8080/v1", "http://[::1]:8080/v1", "https://ff-models.example/api/v1"]) assert.equal(textBaseUrl(url), url);
  for (const url of ["file:///tmp/key", "https://name:secret@example.com/v1", "https://example.com/v1?key=secret", "https://example.com/v1#secret", "http://169.254.169.254/latest", "http://2852039166/latest", "http://[::ffff:a9fe:a9fe]/latest", "http://[fd00:ec2::254]/latest", "http://metadata.google.internal", "http://[fe80::1]", "http://224.0.0.1", "http://0.0.0.0", "http://[::]", "https://example.com/%2fprivate", "https://example.com/\nprivate"]) assert.throws(() => textBaseUrl(url), { code: "INVALID_TEXT_SETTINGS" });
});

test("Gemini discovery pages safely, filters specialized models, caches and sends native structured generation", async t => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = await fixture(t, async (input, init) => {
    const url = String(input); calls.push({ url, init });
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), secret);
    assert.equal(url.includes(secret), false); assert.equal(init?.redirect, "error");
    if (url.includes(":generateContent")) {
      const body = JSON.parse(String(init!.body));
      assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-test-flash:generateContent");
      assert.equal(body.generationConfig.maxOutputTokens, 4096);
      assert.equal(body.generationConfig.responseFormat.text.mimeType, "APPLICATION_JSON");
      assert.deepEqual(body.generationConfig.responseFormat.text.schema.required, ["prompt"]);
      assert.equal(JSON.parse(body.contents[0].parts[0].text).prompt, "A ceramic cup.");
      assert.equal(body.tools, undefined);
      return geminiCompletion();
    }
    if (url.includes("pageToken=")) return geminiList();
    return Response.json({ models: [
      { name: "models/gemini-image-preview", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-live-audio", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-embedding", supportedGenerationMethods: ["embedContent"] },
    ], nextPageToken: "page-two" });
  });
  f.credentials.set("gemini", secret);
  const found = await f.service.models("gemini");
  assert.deepEqual(found.models.map(model => model.id), ["gemini-test-flash"]);
  await f.service.models("gemini"); assert.equal(calls.length, 2, "a bounded cache avoids repeated cloud discovery");
  await f.service.saveAssistant({ revision: 0, provider: "gemini", modelId: "gemini-test-flash" });
  const result = await f.service.refine(f.input());
  assert.equal(result.provider, "gemini"); assert.equal(result.originalPrompt, "A ceramic cup.");
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 18 });
  assert.equal(f.store.jobs().length, 0);
});

test("compatible generation uses saved server credentials and supports an initial prompt from instructions", async t => {
  let posts = 0;
  const f = await fixture(t, async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
    if (String(url).endsWith("/models")) return list();
    posts++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "local-chat"); assert.equal(body.stream, false); assert.equal(body.max_tokens, 4096);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.deepEqual(JSON.parse(body.messages[1].content), { prompt: "", instruction: "A ceramic cup on a wooden table." });
    return completion();
  });
  await f.connect();
  const result = await f.service.refine({ ...f.input(), prompt: "", instruction: "A ceramic cup on a wooden table." });
  assert.equal(result.originalPrompt, ""); assert.equal(result.prompt, "A ceramic cup on a wooden table.");
  assert.equal(posts, 1);
  assert.throws(() => f.service.refine({ ...f.input(), prompt: " ", instruction: " " }), { code: "INVALID_TEXT_SETTINGS" });
});

test("stale selection, unknown models and unsupported request fields never invoke generation", async t => {
  let posts = 0;
  const f = await fixture(t, async (_url, init) => { if (init?.method === "POST") posts++; return list(); });
  await f.connect();
  assert.throws(() => f.service.refine({ ...f.input(), settingsRevision: 0 }), { code: "TEXT_SETTINGS_CHANGED" });
  assert.throws(() => f.service.refine({ ...f.input(), imageModelId: "unknown" }), { code: "INVALID_TEXT_SETTINGS" });
  assert.throws(() => f.service.refine({ ...f.input(), apiKey: "client-supplied-secret" }), { code: "INVALID_TEXT_SETTINGS" });
  await assert.rejects(f.service.saveAssistant({ revision: f.service.settings().revision, provider: "openai-compatible", modelId: "unlisted-model" }), { code: "TEXT_MODEL_UNAVAILABLE" });
  assert.equal(posts, 0);
});

test("one refinement runs at a time; abort frees the slot and does not retry the accepted request", async t => {
  let started!: () => void, posts = 0, hang = true;
  const began = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, async (url, init) => {
    if (String(url).endsWith("/models")) return list();
    posts++;
    if (!hang) return completion();
    started();
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error(`reflected ${secret}`)), { once: true }));
  });
  await f.connect();
  const controller = new AbortController();
  const pending = f.service.refine(f.input(), controller.signal);
  const rejected = assert.rejects(pending, { code: "TEXT_CANCELLED" });
  await began;
  assert.throws(() => f.service.refine(f.input()), { code: "TEXT_BUSY" });
  controller.abort(); await rejected;
  assert.equal(posts, 1);
  hang = false; assert.equal((await f.service.refine(f.input())).provider, "openai-compatible");
  assert.equal(posts, 2);
});

test("timeouts include response body reads and close aborts outstanding operations", async t => {
  let cancelled = false;
  const f = await fixture(t, async url => String(url).endsWith("/models") ? list() : new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"choices":')); }, cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } }), 30);
  await f.connect();
  await assert.rejects(f.service.refine(f.input()), { code: "TEXT_TIMEOUT" });
  assert.equal(cancelled, true);
  const pending = f.service.refine(f.input());
  const stopped = assert.rejects(pending, { code: "TEXT_STOPPING" });
  await f.service.close(); await stopped;
  assert.throws(() => f.service.refine(f.input()), { code: "TEXT_STOPPING" });
});

test("changing connection settings aborts in-flight requests and does not forward old keys", async t => {
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, async (url, init) => {
    if (String(url).endsWith("/models")) return list();
    started(); return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
  });
  await f.connect();
  const pending = f.service.refine(f.input()); const rejected = assert.rejects(pending, { code: "TEXT_SETTINGS_CHANGED" });
  await began;
  f.service.saveConnection({ revision: f.service.settings().revision, baseUrl: "https://new.example/v1" });
  await rejected;
  assert.equal(f.credentials.get("text-openai-compatible"), undefined);
});

test("provider HTTP failures are sanitized and never retried with a different request", async t => {
  for (const [status, code] of [[401, "TEXT_ACCESS_DENIED"], [403, "TEXT_ACCESS_DENIED"], [429, "TEXT_RATE_LIMITED"], [400, "TEXT_REQUEST_UNSUPPORTED"], [500, "TEXT_UNAVAILABLE"]] as const) await t.test(String(status), async t => {
    let calls = 0;
    const f = await fixture(t, async (url) => {
      if (String(url).endsWith("/models")) return list();
      calls++; return new Response(`reflected key: ${secret}`, { status });
    });
    await f.connect();
    await assert.rejects(f.service.refine(f.input()), error => { assert.equal((error as { code: string }).code, code); assert.equal(String(error).includes(secret), false); return true; });
    assert.equal(calls, 1);
  });
});

test("malformed, truncated, oversized, tool and secret-reflecting completions are rejected", async t => {
  const cases: Array<[string, () => Response]> = [
    ["truncated", () => Response.json({ choices: [{ finish_reason: "length", message: { content: '{"prompt":"A cup"}' } }] })],
    ["missing-stop", () => Response.json({ choices: [{ message: { content: '{"prompt":"A cup"}' } }] })],
    ["tool", () => Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"prompt":"A cup"}', tool_calls: [{}] } }] })],
    ["html", () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } })],
    ["huge", () => new Response("x".repeat(524289), { headers: { "content-type": "application/json" } })],
    ["empty", () => completion("")],
    ["extra-fields", () => Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"prompt":"A cup","extra":"x"}' } }] })],
    ["secret", () => completion(secret)],
    ["escaped-secret", () => Response.json({ choices: [{ finish_reason: "stop", message: { content: `{"prompt":"${[...secret].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"}` } }] })],
  ];
  for (const [name, response] of cases) await t.test(name, async t => {
    const f = await fixture(t, async url => String(url).endsWith("/models") ? list() : response()); await f.connect();
    await assert.rejects(f.service.refine(f.input()), error => { assert.equal(String(error).includes(secret), false); return true; });
    assert.equal(f.store.jobs().length, 0);
  });
});

test("model discovery rejects pagination loops and credentials reflected in public metadata", async t => {
  for (const scenario of ["loop", "secret", "too-many"] as const) await t.test(scenario, async t => {
    let calls = 0;
    const f = await fixture(t, async () => { calls++; return Response.json(scenario === "loop" ? { models: [], nextPageToken: "repeat" } : scenario === "secret" ? { models: [{ name: "models/gemini-test", displayName: secret, supportedGenerationMethods: ["generateContent"] }] } : { models: Array.from({ length: 501 }, () => ({})) }); });
    f.credentials.set("gemini", secret);
    await assert.rejects(f.service.models("gemini"), { code: "TEXT_INVALID_RESPONSE" });
    assert(calls <= 2);
  });
});

test("rotating a Gemini key invalidates cached discovery", async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return geminiList(); });
  f.credentials.set("gemini", secret);
  await f.service.models("gemini"); await f.service.models("gemini"); assert.equal(calls, 1);
  f.credentials.set("gemini", "replacement-gemini-key");
  await f.service.models("gemini"); assert.equal(calls, 2);
});

test("explicit connection checks bypass cached discovery and discard it after a failure", async t => {
  let calls = 0, offline = false;
  const f = await fixture(t, async () => { calls++; if (offline) throw new Error("offline"); return list(); });
  f.service.saveConnection({ revision: 0, baseUrl: "http://localhost:8080/v1" });
  await f.service.models("openai-compatible");
  await f.service.models("openai-compatible"); assert.equal(calls, 1);
  await f.service.models("openai-compatible", undefined, true); assert.equal(calls, 2);
  offline = true;
  await assert.rejects(f.service.models("openai-compatible", undefined, true), { code: "TEXT_UNAVAILABLE" });
  await assert.rejects(f.service.models("openai-compatible"), { code: "TEXT_UNAVAILABLE" });
  assert.equal(calls, 4, "failed live checks cannot leave a successful cached connection result");
});

test("a Gemini credential rotated during discovery cannot publish the old account's model list", async t => {
  let respond!: (response: Response) => void, started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, async () => { started(); return new Promise<Response>(resolve => { respond = resolve; }); });
  f.credentials.set("gemini", secret);
  const pending = f.service.models("gemini"); const rejected = assert.rejects(pending, { code: "TEXT_SETTINGS_CHANGED" });
  await began; f.credentials.set("gemini", "replacement-gemini-key");
  respond(geminiList()); await rejected;
});
