import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ModelLibrary, huggingFaceFile } from "../../apps/server/models.ts";
import { modelRegistry } from "../../apps/server/registry.ts";
import { settingsView } from "../../apps/server/settings.ts";
import { Store } from "../../apps/server/store.ts";
import { BIREFNET_ARTIFACT, UPSCALER_MODELS, type ModelArtifact } from "../../packages/inference/index.ts";

const ids = ["nomos2-hq", "seedvr2-3b", "seedvr2-7b"];
const model = (id: string) => {
  const found = UPSCALER_MODELS.find(model => model.id === id);
  assert.ok(found, `Missing upscaler ${id}`);
  return found;
};
const bytes = (() => {
  const header = Buffer.from(JSON.stringify({ weight: { dtype: "F32", shape: [1], data_offsets: [0, 4] } }));
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([length, header, Buffer.alloc(4)]);
})();

async function fixture(t: TestContext, options: ConstructorParameters<typeof ModelLibrary>[2] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gravity-upscale-models-"));
  const store = new Store(directory);
  const calls = { invalidations: 0, refreshes: 0 };
  const library = new ModelLibrary(store, {
    invalidateWorkers() { calls.invalidations++; },
    async refreshWorkers(force) { assert.equal(force, true); calls.refreshes++; },
    availableWorkers() { assert.fail("Utility downloads must not activate an image model"); },
  }, { fetch: async () => assert.fail("This operation must not contact Hugging Face"), ...options });
  t.after(async () => { await library.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, library, calls };
}

test("native upscalers appear as downloadable utilities without changing image model settings", async t => {
  const { store, library } = await fixture(t);
  const before = settingsView(store), registry = modelRegistry(store);
  const view = await library.view();
  const tools = view.models.filter(item => "category" in item && item.category === "upscale");
  assert.deepEqual(tools.map(item => item.id), ids);
  for (const tool of tools) {
    const manifest = model(tool.id);
    assert.equal("kind" in tool && tool.kind, "utility");
    assert.equal(tool.familyId, "upscale");
    assert.equal(tool.family, "Upscaling");
    assert.equal(tool.source, "catalog");
    assert.equal(tool.downloadable, true);
    assert.equal(tool.installed, false);
    assert.equal(tool.enabled, false);
    assert.equal(tool.license, manifest.license);
    assert.equal(tool.licenseUrl, manifest.licenseUrl);
    assert.deepEqual(tool.artifacts, manifest.artifacts.map(artifact => ({ role: artifact.role, filename: artifact.filename, installed: false })));
    assert.equal(tool.repositories.length, 1);
    for (const artifact of manifest.artifacts) {
      assert.match(huggingFaceFile(artifact.source), /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[a-f0-9]{40}\/.+\.safetensors$/);
      assert.match(artifact.sha256!, /^[a-f0-9]{64}$/);
    }
  }
  const background = view.models.find(item => item.id === "birefnet")!;
  assert.equal(background.familyId, "background-removal");
  assert.equal(background.license, "MIT");
  assert.equal(background.downloadable, true);
  assert.deepEqual(background.artifacts, [{ role: BIREFNET_ARTIFACT.role, filename: BIREFNET_ARTIFACT.filename, installed: false }]);
  assert.equal(view.download, null);
  assert.deepEqual(settingsView(store), before);
  assert.deepEqual(modelRegistry(store), registry);
  assert.equal(registry.some(item => ids.includes(item.id)), false);
});

test("SeedVR2 installation requires its own DiT and the shared VAE; local utilities need no activation", async t => {
  const { directory, store, library } = await fixture(t);
  const before = settingsView(store);
  const small = model("seedvr2-3b"), large = model("seedvr2-7b");
  const vae = small.artifacts.find(artifact => artifact.role === "vae")!;
  assert.deepEqual(large.artifacts.find(artifact => artifact.role === "vae"), vae);
  async function install(artifact: ModelArtifact) {
    const path = join(directory, "models", artifact.folder, artifact.filename);
    await mkdir(dirname(path), { recursive: true });
    // Library browsing checks file presence. The downloader verifies pinned bytes separately.
    await writeFile(path, bytes);
  }
  await install(vae);
  let view = await library.view();
  for (const id of [small.id, large.id]) {
    const entry = view.models.find(item => item.id === id)!;
    assert.equal(entry.installed, false);
    assert.equal(entry.enabled, false);
    assert.equal(entry.artifacts.find(artifact => artifact.role === "vae")!.installed, true);
  }
  await install(small.artifacts.find(artifact => artifact.role === "diffusion")!);
  view = await library.view();
  assert.equal(view.models.find(item => item.id === small.id)!.enabled, true);
  assert.equal(view.models.find(item => item.id === large.id)!.enabled, false);
  await install(large.artifacts.find(artifact => artifact.role === "diffusion")!);
  await install(model("nomos2-hq").artifacts[0]);
  view = await library.view();
  for (const id of ids) {
    const entry = view.models.find(item => item.id === id)!;
    assert.equal(entry.installed, true);
    assert.equal(entry.enabled, true);
  }
  assert.deepEqual(settingsView(store), before);
  assert.equal(modelRegistry(store).some(item => ids.includes(item.id)), false);
});

test("empty or symlinked upscaler files are not installed utilities", async t => {
  const { directory, library } = await fixture(t);
  const artifact = model("nomos2-hq").artifacts[0];
  const path = join(directory, "models", artifact.folder, artifact.filename);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "");
  assert.equal((await library.view()).models.find(item => item.id === "nomos2-hq")!.installed, false);
  await rm(path);
  const outside = join(directory, "unmanaged.safetensors");
  await writeFile(outside, bytes);
  await symlink(outside, path);
  assert.equal((await library.view()).models.find(item => item.id === "nomos2-hq")!.enabled, false);
});

test("upscaler access checks probe pinned artifacts with HEAD and keep credentials and signed URLs private", async t => {
  const requests: string[] = [];
  const { directory, store, library } = await fixture(t, {
    huggingFaceToken: () => "fixture-upscale-private-token",
    fetch: async (input, init) => {
      requests.push(String(input));
      assert.equal(init?.method, "HEAD");
      assert.equal(init?.redirect, "manual");
      assert.equal(new URL(String(input)).hostname, "huggingface.co");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-upscale-private-token");
      return new Response(null, { status: 302, headers: { location: "https://us.aws.cdn.hf.co/weights?signature=fixture-private-signature" } });
    },
  });
  const before = settingsView(store);
  for (const id of ids) {
    requests.length = 0;
    const result = await library.checkAccess({ modelId: id });
    assert.equal(result.available, true);
    assert.equal(result.modelId, id);
    assert.equal(result.hasToken, true);
    assert.deepEqual(requests, model(id).artifacts.map(artifact => huggingFaceFile(artifact.source)));
    assert.equal(result.repositories.length, 1);
    assert.equal(result.repositories[0].status, "available");
    assert.equal(JSON.stringify(result).includes("fixture-private"), false);
    assert.equal(JSON.stringify(result).includes("fixture-upscale-private-token"), false);
  }
  assert.equal((await library.view()).download, null);
  assert.equal((await readdir(directory)).includes("models"), false);
  assert.deepEqual(settingsView(store), before);
});

test("a gated SeedVR2 artifact blocks both access and download without registering or activating it", async t => {
  for (const status of [401, 403]) await t.test(String(status), async t => {
    const requests: { method: string; url: string }[] = [];
    const { directory, store, library, calls } = await fixture(t, { fetch: async (input, init) => {
      requests.push({ method: init?.method ?? "GET", url: String(input) });
      return new Response(null, { status, headers: { "x-error-code": "GatedRepo", "x-error-message": "fixture-provider-secret" } });
    } });
    const before = settingsView(store), id = "seedvr2-3b";
    const access = await library.checkAccess({ modelId: id });
    assert.equal(access.available, false);
    assert.equal(access.repositories[0].status, "gated");
    assert.equal(requests.length, model(id).artifacts.length);
    library.start({ modelId: id }); await library.waitForIdle();
    const view = await library.view();
    assert.equal(view.download?.status, "failed");
    assert.equal(view.download?.errorCode, "MODEL_ACCESS_GATED");
    assert.equal(view.download?.access?.status, "gated");
    assert.equal(requests.filter(request => request.method === "GET").length, 1);
    assert.equal(view.models.find(item => item.id === id)!.enabled, false);
    assert.equal(JSON.stringify(view).includes("fixture-provider-secret"), false);
    assert.deepEqual(calls, { invalidations: 0, refreshes: 0 });
    assert.deepEqual(settingsView(store), before);
    assert.equal(modelRegistry(store).some(item => item.id === id), false);
    const artifact = model(id).artifacts[0];
    assert.deepEqual(await readdir(join(directory, "models", artifact.folder)), []);
  });
});

test("corrupt or incomplete utility downloads never publish model files or enable upscaling", async t => {
  for (const id of ids) for (const failure of ["checksum", "incomplete"] as const) await t.test(`${id}: ${failure}`, async t => {
    const requests: string[] = [];
    const { directory, store, library, calls } = await fixture(t, { fetch: async input => {
      requests.push(String(input));
      return new Response(bytes, { headers: { "content-length": String(bytes.length + (failure === "incomplete" ? 1 : 0)) } });
    } });
    const before = settingsView(store);
    const started = library.start({ modelId: id });
    assert.equal(started.totalFiles, model(id).artifacts.length);
    await library.waitForIdle();
    const view = await library.view();
    assert.equal(view.download?.status, "failed");
    assert.equal(view.download?.errorCode, failure === "incomplete" ? "MODEL_INCOMPLETE" : "MODEL_CHECKSUM_MISMATCH");
    assert.equal(view.download?.completedFiles, 0);
    assert.deepEqual(requests, [huggingFaceFile(model(id).artifacts[0].source)]);
    assert.equal(view.models.find(item => item.id === id)!.enabled, false);
    for (const artifact of model(id).artifacts) {
      const path = join(directory, "models", artifact.folder, artifact.filename);
      await assert.rejects(readFile(path), { code: "ENOENT" });
      await assert.rejects(readFile(`${path}.part`), { code: "ENOENT" });
    }
    assert.deepEqual(calls, { invalidations: 0, refreshes: 0 });
    assert.deepEqual(settingsView(store), before);
    assert.equal(modelRegistry(store).some(item => item.id === id), false);
  });
});

test("completing utility downloads refreshes workers without importing a model or requiring activation", async t => {
  for (const id of [...ids, "birefnet"]) await t.test(id, async t => {
    const { store, library, calls } = await fixture(t);
    const before = settingsView(store), registry = modelRegistry(store), verified: ModelArtifact[] = [];
    // Isolate the post-download lifecycle from multi-gigabyte pinned weights.
    // Actual stream, checksum and publication failures are exercised above.
    const download = library as unknown as { downloadFile(artifact: ModelArtifact, verified: (digest: string) => void): Promise<string> };
    t.mock.method(download, "downloadFile", async (artifact: ModelArtifact, record: (digest: string) => void) => {
      verified.push(artifact);
      record(artifact.sha256!);
      return artifact.sha256!;
    });
    library.start({ modelId: id }); await library.waitForIdle();
    const view = await library.view();
    assert.equal(view.download?.status, "succeeded", view.download?.error ?? "Utility download should complete");
    assert.equal(view.download?.completedFiles, verified.length);
    assert.equal(verified.length, id === "birefnet" ? 1 : model(id).artifacts.length);
    assert.match(view.download!.stage, id === "birefnet" ? /Transparent background/ : /Upscaling/);
    assert.deepEqual(calls, { invalidations: 1, refreshes: 1 });
    assert.deepEqual(modelRegistry(store), registry);
    assert.deepEqual(settingsView(store), before);
  });
});
