import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../apps/server/engine.ts";
import { ModelLibrary, huggingFaceFile } from "../../apps/server/models.ts";
import { modelRegistry, saveImportedModel } from "../../apps/server/registry.ts";
import { configuredModel, settingsView, validateSettings } from "../../apps/server/settings.ts";
import { Store } from "../../apps/server/store.ts";
import type { ModelManifest } from "../../packages/inference/index.ts";
import { engineFixture, GiB, inventory } from "./helpers/engine-fixture.ts";

const source = "https://huggingface.co/example/checkpoints/blob/main/portrait.safetensors";
const importRequest = { url: source, name: "Portrait", familyId: "sdxl" };
function safetensors() {
  const header = Buffer.from(JSON.stringify({ "model.diffusion_model.test": { dtype: "F32", shape: [1], data_offsets: [0, 4] } }));
  const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([size, header, Buffer.alloc(4)]);
}
const bytes = safetensors();
const sha256 = createHash("sha256").update(bytes).digest("hex");
const response = (data: Uint8Array = bytes) => new Response(Uint8Array.from(data), { headers: { "content-length": String(data.byteLength) } });
const noWorkers = { invalidateWorkers() {}, async refreshWorkers() {}, availableWorkers() { return []; } };

async function fixture(t: TestContext, options: ConstructorParameters<typeof ModelLibrary>[2] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gravity-models-"));
  const store = new Store(directory);
  const library = new ModelLibrary(store, noWorkers, { fetch: async () => response(), ...options });
  t.after(async () => { await library.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, library };
}

test("an existing studio discovers Qwen's download and capabilities without enabling it or replacing saved model settings", async t => {
  const { store, library } = await fixture(t, { fetch: async () => assert.fail("Browsing the catalog must not download model files") });
  const previous = settingsView(store);
  previous.modelConfigurations = previous.modelConfigurations.filter(model => model.modelId !== "qwen-image-2.1");
  const customized = previous.modelConfigurations.find(model => model.modelId === "sdxl-base")!;
  customized.artifacts.checkpoint = "my-portrait.safetensors";
  customized.memory = { ramBytes: 20 * GiB, vramBytes: 12 * GiB, source: "estimate" };
  store.saveSettings(previous);

  const catalog = await new Engine(store).catalog();
  const card = catalog.models.find(model => model.id === "qwen-image-2.1");
  assert.ok(card, "Qwen appears for studios configured before this model was added");
  assert.equal(card.familyId, "qwen-image-2.1");
  assert.equal(card.ready, false);
  assert.deepEqual(card.operations, ["text-to-image", "reference"]);
  assert.equal(card.capabilities.imageInput, true);
  assert.equal(card.capabilities.maxImages, 10);
  assert.equal(card.limits.maxImages, 10);
  assert.equal(card.capabilities.negativePrompt, true);
  assert.equal(card.license, "Qwen Research License (non-commercial)");

  const available = await library.view();
  const entry = available.models.find(model => model.id === card.id);
  assert.ok(entry);
  assert.equal(entry.source, "catalog");
  assert.equal(entry.license, card.license);
  assert.equal(entry.downloadable, true);
  assert.equal(entry.installed, false);
  assert.equal(entry.enabled, false);
  assert.equal(available.download, null);
  assert.deepEqual(entry.artifacts.map(artifact => artifact.role), ["diffusion", "text-encoder", "vae"]);
  assert.ok(entry.artifacts.every(artifact => !artifact.installed));
  for (const artifact of card.artifacts) assert.match(huggingFaceFile(artifact.source), /^https:\/\/huggingface\.co\/Comfy-Org\/Qwen-Image-2\.1\/resolve\/[a-f0-9]{40}\//);
  await assert.rejects(library.activate({ modelId: card.id }), { code: "MODEL_FILES_MISSING" });

  const settings = settingsView(store);
  const configuration = settings.modelConfigurations.find(model => model.modelId === card.id)!;
  assert.equal(configuration.enabled, false);
  assert.deepEqual(configuration.workerIds, []);
  assert.deepEqual(configuration.memory, { ramBytes: 48 * GiB, vramBytes: 24 * GiB, source: "estimate" });
  assert.deepEqual(configuration.artifacts, Object.fromEntries(card.artifacts.map(artifact => [artifact.role, artifact.filename])));
  assert.deepEqual(settings.modelConfigurations.find(model => model.modelId === customized.modelId), customized);
  store.saveSettings(validateSettings(settings, inventory(), modelRegistry(store)));
  assert.deepEqual(store.settings().modelConfigurations.find(model => model.modelId === card.id), configuration);
  assert.deepEqual(store.settings().modelConfigurations.find(model => model.modelId === customized.modelId), customized);
});

test("Hugging Face links normalize to file downloads and reject unsupported sources", () => {
  assert.equal(huggingFaceFile(`${source}?download=true`), source.replace("/blob/", "/resolve/"));
  for (const url of ["http://huggingface.co/example/repo/blob/main/a.safetensors", "https://huggingface.co.attacker.example/a/b/blob/main/c.safetensors", "https://name:secret@huggingface.co/a/b/blob/main/c.safetensors", "https://huggingface.co:8443/a/b/blob/main/c.safetensors", "https://127.0.0.1/a/b/blob/main/c.safetensors", "https://huggingface.co/a/b/blob/main/a.ckpt", "https://huggingface.co/a/b/resolve/main/%2foutside.safetensors", "https://huggingface.co/a/b/resolve/main/%5coutside.safetensors", `${source}?token=secret`, "https://huggingface.co/example/checkpoints"]) assert.throws(() => huggingFaceFile(url), { code: "INVALID_MODEL_SOURCE" });
});

test("a streamed checkpoint installs atomically, records its digest and remains available after restart", async t => {
  const { directory, store, library } = await fixture(t);
  const download = library.start(importRequest);
  assert.equal(library.busy(), true);
  assert.throws(() => library.start(importRequest), { code: "MODEL_DOWNLOAD_BUSY" });
  await library.waitForIdle();
  const view = await library.view();
  assert.equal(view.download?.status, "succeeded");
  assert.match(view.download!.stage, /Start the image engine/);
  const model = modelRegistry(store).find(item => item.id === download.modelId)!;
  assert.equal(model.artifacts[0].sha256, sha256);
  const destination = join(directory, "models", "checkpoints", model.artifacts[0].filename);
  assert.deepEqual(await readFile(destination), bytes);
  await assert.rejects(readFile(`${destination}.part`), { code: "ENOENT" });
  assert.equal(view.models.find(item => item.id === model.id)?.installed, true);
  assert.equal(view.models.find(item => item.id === model.id)?.enabled, false);
  const configuration = settingsView(store).modelConfigurations.find(item => item.modelId === model.id)!;
  assert.equal(configuredModel(configuration, store).id, model.id);
  assert.equal(validateSettings(settingsView(store), inventory(), modelRegistry(store)).modelConfigurations.at(-1)?.modelId, model.id);
  const reopened = new Store(directory);
  try { assert.equal(modelRegistry(reopened).at(-1)?.artifacts[0].sha256, sha256); }
  finally { reopened.close(); }
});

test("downloads never follow redirects to local or arbitrary hosts", async t => {
  for (const target of ["http://127.0.0.1/private", "https://169.254.169.254/metadata", "https://attacker.example/model.safetensors", "https://huggingface.co.attacker.example/file", "https://name:secret@cas-bridge.xethub.hf.co/file"]) await t.test(target, async t => {
    let requests = 0;
    const { library } = await fixture(t, { fetch: async () => { requests++; return new Response(null, { status: 302, headers: { location: target } }); } });
    library.start(importRequest); await library.waitForIdle();
    assert.equal(requests, 1);
    assert.equal((await library.view()).download?.status, "failed");
    assert.match((await library.view()).download!.error!, /unsupported download host/);
  });
});

test("HF credentials are sent only to Hugging Face and never forwarded to its CDN", async t => {
  const previous = process.env.HF_TOKEN; process.env.HF_TOKEN = "fixture-private-token";
  t.after(() => { if (previous === undefined) delete process.env.HF_TOKEN; else process.env.HF_TOKEN = previous; });
  const calls: { host: string; authorization: string | null }[] = [];
  const redirects = ["cas-bridge.xethub.hf.co", "us.aws.cdn.hf.co", "us.gcp.cdn.hf.co"];
  const { library } = await fixture(t, { fetch: async (input, init) => {
    const url = new URL(String(input)); calls.push({ host: url.hostname, authorization: new Headers(init?.headers).get("Authorization") });
    const host = redirects[calls.length - 1];
    return host ? new Response(null, { status: 302, headers: { location: `https://${host}/test?signature=fixture` } }) : response();
  } });
  library.start(importRequest); await library.waitForIdle();
  assert.equal((await library.view()).download?.status, "succeeded");
  assert.deepEqual(calls, [{ host: "huggingface.co", authorization: "Bearer fixture-private-token" }, ...redirects.map(host => ({ host, authorization: null }))]);
  assert(!JSON.stringify(await library.view()).includes("fixture-private-token"));
});

test("checksum mismatch removes the partial and a retry installs the verified file", async t => {
  let corrupt = true;
  const { directory, store, library } = await fixture(t, { fetch: async () => response(corrupt ? Uint8Array.from(bytes, byte => byte ^ 1) : bytes) });
  const model: ModelManifest = { id: "fixture-checkpoint", name: "Pinned checkpoint", familyId: "sdxl", revision: "1", artifacts: [{ role: "checkpoint", folder: "checkpoints", filename: "pinned.safetensors", source, sha256 }] };
  saveImportedModel(store, model);
  library.start({ modelId: model.id }); await library.waitForIdle();
  assert.match((await library.view()).download!.error!, /SHA-256/);
  assert.deepEqual(await readdir(join(directory, "models", "checkpoints")), []);
  corrupt = false;
  library.start({ modelId: model.id }); await library.waitForIdle();
  assert.equal((await library.view()).download?.status, "succeeded");
  assert.deepEqual(await readFile(join(directory, "models", "checkpoints", model.artifacts[0].filename)), bytes);
});

test("an existing different model and symlink destinations remain untouched", async t => {
  const { directory, store, library } = await fixture(t);
  const model: ModelManifest = { id: "fixture-existing", name: "Existing", familyId: "sdxl", revision: "1", artifacts: [{ role: "checkpoint", folder: "checkpoints", filename: "existing.safetensors", source, sha256 }] };
  saveImportedModel(store, model);
  const folder = join(directory, "models", "checkpoints"); await mkdir(folder, { recursive: true });
  const target = join(folder, model.artifacts[0].filename); await writeFile(target, "private-existing-file");
  library.start({ modelId: model.id }); await library.waitForIdle();
  assert.equal(await readFile(target, "utf8"), "private-existing-file");
  assert.match((await library.view()).download!.error!, /left unchanged/);
  await rm(target); await symlink(join(directory, "studio.sqlite"), target);
  library.start({ modelId: model.id }); await library.waitForIdle();
  assert.match((await library.view()).download!.error!, /left unchanged/);
});

test("activation checks pinned bytes and detects files changed after a successful download", async t => {
  const { directory, store, library } = await fixture(t);
  const started = library.start(importRequest); await library.waitForIdle();
  const model = modelRegistry(store).find(item => item.id === started.modelId)!;
  const target = join(directory, "models", "checkpoints", model.artifacts[0].filename);
  await writeFile(target, Uint8Array.from(bytes, byte => byte ^ 1));
  await assert.rejects(library.activate({ modelId: model.id }), { code: "MODEL_FILE_CONFLICT" });
  assert.equal(settingsView(store).modelConfigurations.find(item => item.modelId === model.id)?.enabled, false);
});

test("shutdown aborts a pending stream and removes its partial file", async t => {
  let requested!: () => void;
  const requestSeen = new Promise<void>(resolve => { requested = resolve; });
  const { directory, library } = await fixture(t, { fetch: async (_input, init) => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.subarray(0, 10));
      init!.signal!.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
    } });
    requested();
    return new Response(stream, { headers: { "content-length": String(bytes.length) } });
  } });
  library.start(importRequest); await requestSeen;
  await library.close();
  const view = await library.view();
  assert.equal(view.download?.status, "failed");
  assert.equal(library.busy(), false);
  const model = view.models.find(model => model.source === "huggingface")!;
  const target = join(directory, "models", "checkpoints", model.artifacts[0].filename);
  await assert.rejects(readFile(target), { code: "ENOENT" });
  await assert.rejects(readFile(`${target}.part`), { code: "ENOENT" });
});

test("insufficient disk, truncated bodies, oversized streams and HTML never become model files", async t => {
  for (const scenario of ["disk", "truncated", "oversized", "html", "no-size"] as const) await t.test(scenario, async t => {
    const { directory, library } = await fixture(t, {
      ...(scenario === "disk" ? { availableBytes: async () => bytes.length } : {}),
      fetch: async () => scenario === "html" ? response(Buffer.from("<html>Not a checkpoint</html>")) : new Response(bytes, { headers: scenario === "no-size" ? {} : { "content-length": String(bytes.length + (scenario === "truncated" ? 1 : scenario === "oversized" ? -1 : 0)) } }),
    });
    library.start(importRequest); await library.waitForIdle();
    assert.equal((await library.view()).download?.status, "failed");
    const imported = (await library.view()).models.find(model => model.source === "huggingface")!;
    assert.equal(imported.installed, false);
    const file = join(directory, "models", "checkpoints", imported.artifacts[0].filename);
    await assert.rejects(readFile(file), { code: "ENOENT" });
    await assert.rejects(readFile(`${file}.part`), { code: "ENOENT" });
  });
});

test("only local managed workers with live matching capabilities activate a downloaded checkpoint", async t => {
  const fixture = await engineFixture({ count: 2, location: "local" }); t.after(fixture.close);
  const library = new ModelLibrary(fixture.store, fixture.engine, { fetch: async () => response() }); t.after(() => library.close());
  await mkdir(join(fixture.directory, "runtime"));
  await writeFile(join(fixture.directory, "runtime", "plan.json"), JSON.stringify({ workers: [fixture.store.settings().workers[0]] }));
  const started = library.start(importRequest); await library.waitForIdle();
  assert.equal((await library.view()).models.find(model => model.id === started.modelId)?.enabled, false);
  const imported = modelRegistry(fixture.store).find(model => model.id === started.modelId)!;
  for (const worker of fixture.workers) {
    worker.state.info.CheckpointLoaderSimple.input!.required!.ckpt_name = [[imported.artifacts[0].filename]];
    const previous = worker.state.responseOverride;
    worker.state.responseOverride = path => path === "/models/checkpoints" ? { body: JSON.stringify([imported.artifacts[0].filename]) } : previous?.(path);
  }
  await library.activate({ modelId: imported.id });
  const configuration = fixture.store.settings().modelConfigurations.find(model => model.modelId === imported.id)!;
  assert.equal(configuration.enabled, true); assert.deepEqual(configuration.workerIds, ["worker-0"]);
  const card = (await fixture.engine.catalog()).models.find(model => model.id === imported.id)!;
  assert.equal(card.ready, true); assert.equal(card.name, "Portrait");
  const job = await fixture.queue({ modelId: imported.id });
  assert.equal(job.modelId, imported.id);
  assert.equal((fixture.store.job(job.id).snapshot as { model: ModelManifest }).model.artifacts[0].sha256, sha256);
});

test("catalog-only sources do not advertise a Hugging Face download and stale operations recover visibly", async t => {
  const { store, library } = await fixture(t);
  assert.equal((await library.view()).models.find(model => model.id === "wai-illustrious-v17")?.downloadable, false);
  assert.throws(() => library.start({ modelId: "wai-illustrious-v17" }), { code: "INVALID_MODEL_SOURCE" });
  const original = library.start(importRequest); await library.waitForIdle();
  store.setMetadata("model-download", { ...original, status: "downloading" });
  const recovered = new ModelLibrary(store, noWorkers); t.after(() => recovered.close());
  assert.equal((await recovered.view()).download?.status, "failed");
  assert.match((await recovered.view()).download!.error!, /server restarted/);
});
