import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "../../packages/contracts/index.ts";
import { BIREFNET_ARTIFACT, getModel } from "../../packages/inference/index.ts";
import { ModelLibrary } from "../../apps/server/models.ts";
import { modelRepositories } from "../../apps/server/model-access.ts";
import { modelRegistry, saveImportedModel } from "../../apps/server/registry.ts";
import { Store } from "../../apps/server/store.ts";

const source = "https://huggingface.co/example/checkpoints/blob/pinned-revision/portrait.safetensors?download=true";
const repository = { id: "example/checkpoints", url: "https://huggingface.co/example/checkpoints" };
const noWorkers = { invalidateWorkers() {}, async refreshWorkers() {}, availableWorkers() { return []; } };

async function fixture(t: TestContext, options: ConstructorParameters<typeof ModelLibrary>[2] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gravity-model-access-"));
  const store = new Store(directory);
  const library = new ModelLibrary(store, noWorkers, { fetch: async () => new Response(null), ...options });
  t.after(async () => { await library.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, library };
}

test("access checks distinguish Hub gates, credentials, permissions and missing pinned files without reading error bodies", async t => {
  const cases = [
    { status: 200, expected: "available" },
    { status: 401, header: "GatedRepo", expected: "gated" },
    { status: 403, header: "GatedRepo", expected: "gated" },
    { status: 302, header: "GatedRepo", expected: "gated" },
    { status: 401, expected: "unauthorized" },
    { status: 401, header: "RepoNotFound", expected: "unauthorized" },
    { status: 403, expected: "forbidden" },
    { status: 404, expected: "not_found" },
    { status: 400, header: "RevisionNotFound", expected: "not_found" },
    { status: 400, header: "EntryNotFound", expected: "not_found" },
    { status: 429, expected: "unavailable" },
    { status: 503, expected: "unavailable" },
  ];
  for (const { status, header, expected } of cases) await t.test(`${status} ${header ?? ""}`, async t => {
    let requests = 0, cancelledBodies = 0;
    const { store, library } = await fixture(t, { huggingFaceToken: () => undefined, fetch: async (input, init) => {
      requests++;
      assert.equal(String(input), source.replace("/blob/", "/resolve/").replace("?download=true", ""));
      assert.equal(init?.method, "HEAD");
      assert.equal(init?.redirect, "manual");
      const body = new ReadableStream({ pull() { assert.fail("Access checks must not read response bodies"); }, cancel() { cancelledBodies++; } }, { highWaterMark: 0 });
      return new Response(body, { status, headers: { ...(header ? { "x-error-code": header } : {}), "x-error-message": "provider-secret-and-private-body" } });
    } });
    const result = await library.checkAccess({ url: source });
    assert.equal(requests, 1);
    assert.equal(cancelledBodies, 1);
    assert.equal(result.available, expected === "available");
    assert.equal(result.modelId, undefined);
    assert.match(result.checkedAt, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(result.repositories.map(({ id, url, status }) => ({ id, url, status })), [{ ...repository, status: expected }]);
    assert.equal(JSON.stringify(result).includes("provider-secret"), false);
    assert.equal((await library.view()).download, null);
    assert.equal(modelRegistry(store).some(model => model.id.startsWith("hf-")), false);
  });
});

test("catalog access probes every pinned artifact, aggregates repositories, and treats the public Ideogram mirror as available", async t => {
  const calls: string[] = [];
  const { directory, library } = await fixture(t, { fetch: async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.method, "HEAD");
    return new Response(null, { status: 302, headers: { location: "https://us.aws.cdn.hf.co/weights?signature=private-signed-value" } });
  } });
  const result = await library.checkAccess({ modelId: "ideogram-4-fp8" });
  assert.equal(result.modelId, "ideogram-4-fp8");
  assert.equal(result.available, true);
  assert.deepEqual(calls, getModel("ideogram-4-fp8").artifacts.map(artifact => artifact.source!.replace("/blob/", "/resolve/")));
  assert.equal(calls.length, 4);
  assert.ok(calls.every(url => url.includes("/resolve/2aa6c75ce6d5fabded0ca4d0f76abbfaf8edc87d/")));
  assert.deepEqual(result.repositories.map(({ id, status }) => ({ id, status })), [{ id: "Comfy-Org/Ideogram-4", status: "available" }]);
  assert.equal(JSON.stringify(result).includes("signature"), false);
  assert.equal((await readdir(directory)).includes("models"), false);
});

test("one inaccessible artifact makes its repository and complete model unavailable; the next check is fresh", async t => {
  let missing = true, calls = 0;
  const { library } = await fixture(t, { fetch: async input => {
    calls++;
    return new Response(null, { status: missing && String(input).includes("/vae/") ? 404 : 200 });
  } });
  const first = await library.checkAccess({ modelId: "ideogram-4-fp8" });
  assert.equal(first.available, false);
  assert.equal(first.repositories[0].status, "not_found");
  missing = false;
  const second = await library.checkAccess({ modelId: "ideogram-4-fp8" });
  assert.equal(second.available, true);
  assert.equal(second.repositories[0].status, "available");
  assert.equal(calls, 8);
});

test("library repository links are strict, deduplicated and local, including imports and BiRefNet", async t => {
  const { store, library } = await fixture(t, { fetch: async () => assert.fail("Viewing repository links must not use the network") });
  const imported = { ...structuredClone(getModel("sdxl-base")), id: "imported-access", artifacts: [{ role: "checkpoint" as const, folder: "checkpoints" as const, filename: "import.safetensors", source }] };
  saveImportedModel(store, imported);
  const view = await library.view();
  assert.deepEqual(view.models.find(model => model.id === imported.id)!.repositories, [repository]);
  const ideogram = view.models.find(model => model.id === "ideogram-4-fp8")!;
  assert.deepEqual(ideogram.repositories, [{ id: "Comfy-Org/Ideogram-4", url: "https://huggingface.co/Comfy-Org/Ideogram-4" }]);
  assert.equal("licenseUrl" in ideogram && ideogram.licenseUrl, "https://huggingface.co/ideogram-ai/ideogram-4-fp8/blob/main/LICENSE.md");
  assert.deepEqual(view.models.find(model => model.id === "birefnet")!.repositories, modelRepositories([BIREFNET_ARTIFACT.source]));
  assert.deepEqual(modelRepositories([source, source, "https://huggingface.co.attacker.example/a/b/resolve/main/a.safetensors", "https://name:private@huggingface.co/a/b/resolve/main/a.safetensors", "https://huggingface.co/a/b", `${source}&token=secret`]), [repository]);
});

test("access checks support imported models and the BiRefNet utility without changing the registry or download state", async t => {
  const calls: string[] = [];
  const { store, library } = await fixture(t, { fetch: async input => { calls.push(String(input)); return new Response(null); } });
  const imported = { ...structuredClone(getModel("sdxl-base")), id: "imported-access", artifacts: [{ role: "checkpoint" as const, folder: "checkpoints" as const, filename: "import.safetensors", source }] };
  saveImportedModel(store, imported);
  const before = modelRegistry(store);
  assert.equal((await library.checkAccess({ modelId: imported.id })).available, true);
  assert.equal((await library.checkAccess({ modelId: "birefnet" })).available, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1], BIREFNET_ARTIFACT.source);
  assert.deepEqual(modelRegistry(store), before);
  assert.equal((await library.view()).download, null);
});

test("HEAD follows only safe Hub redirects and never contacts a CDN or leaks its signed URL", async t => {
  const previous = process.env.HF_TOKEN; process.env.HF_TOKEN = "fixture-environment-token";
  t.after(() => { if (previous === undefined) delete process.env.HF_TOKEN; else process.env.HF_TOKEN = previous; });
  const calls: { url: string; token: string | null }[] = [];
  const { library } = await fixture(t, { huggingFaceToken: () => "fixture-vault-token", fetch: async (input, init) => {
    calls.push({ url: String(input), token: new Headers(init?.headers).get("Authorization") });
    assert.equal(init?.method, "HEAD");
    return new Response(null, { status: 302, headers: { location: calls.length === 1 ? "/example/checkpoints/resolve/pinned-revision/moved.safetensors" : "https://cas-bridge.xethub.hf.co/blob?signature=fixture-signed-token" } });
  } });
  const result = await library.checkAccess({ url: source });
  assert.equal(result.available, true);
  assert.equal(result.hasToken, true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => new URL(call.url).hostname === "huggingface.co" && call.token === "Bearer fixture-vault-token"));
  assert.ok(!/fixture-|signature|Authorization/.test(JSON.stringify(result)));
});

test("environment credentials remain a fallback for access checks", async t => {
  const previous = process.env.HF_TOKEN; process.env.HF_TOKEN = "fixture-fallback-token";
  t.after(() => { if (previous === undefined) delete process.env.HF_TOKEN; else process.env.HF_TOKEN = previous; });
  const { library } = await fixture(t, { huggingFaceToken: () => undefined, fetch: async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-fallback-token");
    return new Response(null);
  } });
  assert.equal((await library.checkAccess({ url: source })).hasToken, true);
});

test("access checks reject unsafe redirects and sanitize broken redirects or provider failures", async t => {
  for (const target of ["https://attacker.example/blob?secret=private-value", "http://huggingface.co/example/file", "https://169.254.169.254/metadata", "https://name:private-value@cas-bridge.xethub.hf.co/file", "https://us.aws.cdn.hf.co:8443/file", "http://["]) await t.test(target, async t => {
    let calls = 0;
    const { library } = await fixture(t, { fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location: target } }); } });
    const result = await library.checkAccess({ url: source });
    assert.equal(result.available, false);
    assert.equal(result.repositories[0].status, "unavailable");
    assert.equal(calls, 1);
    assert.ok(!/private-value|attacker|metadata/.test(JSON.stringify(result)));
  });
  for (const error of [new TypeError("secret-token and signed-url"), new DOMException("secret-timeout-details", "TimeoutError")]) await t.test(error.name, async t => {
    const { library } = await fixture(t, { fetch: async () => { throw error; } });
    const result = await library.checkAccess({ url: source });
    assert.equal(result.available, false);
    assert.equal(result.repositories[0].status, "unavailable");
    assert.equal(JSON.stringify(result).includes("secret"), false);
  });
});

test("cancelled access checks cannot publish an available result or expose the abort reason", async t => {
  const controller = new AbortController();
  const { library } = await fixture(t, { fetch: async (_input, init) => {
    assert.ok(init?.signal);
    controller.abort(new Error("private-abort-reason"));
    assert.equal(init.signal.aborted, true);
    return new Response(null);
  } });
  await assert.rejects(library.checkAccess({ url: source }, controller.signal), error => error instanceof ApiError && error.code === "MODEL_ACCESS_CANCELLED" && !error.message.includes("private"));
  await assert.rejects(library.checkAccess({ url: source }, AbortSignal.abort("private-second-reason")), { code: "MODEL_ACCESS_CANCELLED" });
});

test("a token changed during a check invalidates the entire result", async t => {
  let token: string | undefined = "fixture-original-token";
  let calls = 0;
  const { library } = await fixture(t, { huggingFaceToken: () => token, fetch: async (_input, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-original-token");
    token = "fixture-replacement-token";
    return new Response(null);
  } });
  await assert.rejects(library.checkAccess({ modelId: "ideogram-4-fp8" }), error => error instanceof ApiError && error.code === "MODEL_ACCESS_CHANGED" && !error.message.includes("fixture"));
  assert.equal(calls, 4, "all files use the original token snapshot");
  assert.equal((await library.view()).download, null);
});

test("unreadable stored credentials stop access checks without using the environment fallback", async t => {
  const { library } = await fixture(t, { huggingFaceToken: () => { throw new ApiError(503, "CREDENTIALS_UNREADABLE", "Saved credentials could not be unlocked."); }, fetch: async () => assert.fail("Unreadable credentials must not contact Hugging Face") });
  await assert.rejects(library.checkAccess({ url: source }), { code: "CREDENTIALS_UNREADABLE" });
});

test("access requests reject ambiguous payloads and unsupported sources before making requests", async t => {
  const { library } = await fixture(t, { fetch: async () => assert.fail("Invalid access requests must not contact Hugging Face") });
  for (const value of [null, [], {}, { modelId: "sdxl-base", url: source }, { url: source, token: "secret" }, { modelId: 42 }, { url: 42 }, { url: source, name: "name" }]) await assert.rejects(library.checkAccess(value), { code: "INVALID_MODEL_REQUEST" });
  await assert.rejects(library.checkAccess({ modelId: "missing-model" }), { code: "MODEL_NOT_FOUND" });
  for (const url of ["https://huggingface.co/example/checkpoints", "https://attacker.example/model.safetensors", `${source}&token=secret`]) await assert.rejects(library.checkAccess({ url }), { code: "INVALID_MODEL_SOURCE" });
});

test("GET access failures retain safe structured recovery data without adding preflight requests or storing response secrets", async t => {
  for (const { status, header, expected } of [{ status: 401, header: "GatedRepo", expected: "gated" }, { status: 401, expected: "unauthorized" }, { status: 403, expected: "forbidden" }, { status: 404, expected: "not_found" }, { status: 503, expected: "unavailable" }]) await t.test(expected, async t => {
    let calls = 0;
    const { store, library } = await fixture(t, { huggingFaceToken: () => "fixture-private-token", fetch: async (_input, init) => {
      calls++;
      assert.notEqual(init?.method, "HEAD");
      return new Response("provider-private-body", { status, headers: { ...(header ? { "x-error-code": header } : {}), "x-error-message": "private-token-signed-url" } });
    } });
    library.start({ url: source, name: "Access test", familyId: "sdxl" });
    await library.waitForIdle();
    const view = await library.view();
    assert.equal(calls, 1);
    assert.equal(view.download?.status, "failed");
    assert.equal(view.download?.errorCode, `MODEL_ACCESS_${expected.toUpperCase()}`);
    assert.deepEqual(view.download?.access, { repository, status: expected, message: view.download?.error });
    assert.deepEqual(store.metadata("model-download"), view.download);
    assert.ok(!/provider-private|private-token|signed-url/.test(JSON.stringify(view)));
  });
});
