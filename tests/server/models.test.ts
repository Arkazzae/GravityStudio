import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../apps/server/engine.ts";
import { ModelLibrary, huggingFaceFile } from "../../apps/server/models.ts";
import { modelRegistry, saveImportedModel, generationExtensionRegistry } from "../../apps/server/registry.ts";
import { configuredModel, settingsView, validateSettings } from "../../apps/server/settings.ts";
import { Store } from "../../apps/server/store.ts";
import { CredentialVault } from "../../apps/server/credentials.ts";
import type { ModelManifest } from "../../packages/inference/index.ts";
import { getModel } from "../../packages/inference/index.ts";
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
  assert.equal(card.capabilities.imageInput, false, "Reference controls stay unavailable until an assigned worker is ready");
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

test("an existing studio discovers Ideogram's four artifacts without enabling it or changing saved configuration", async t => {
  const { store, library } = await fixture(t, { fetch: async () => assert.fail("Browsing must not download weights") });
  const previous = settingsView(store);
  previous.modelConfigurations = previous.modelConfigurations.filter(model => model.modelId !== "ideogram-4-fp8");
  previous.modelConfigurations[0].artifacts.checkpoint = "custom-checkpoint.safetensors";
  store.saveSettings(previous);
  const card = (await new Engine(store).catalog()).models.find(model => model.id === "ideogram-4-fp8")!;
  assert.equal(card.familyId, "ideogram-4");
  assert.equal(card.ready, false);
  assert.deepEqual(card.operations, ["text-to-image", "image-to-image", "reference"]);
  assert.equal(card.capabilities.imageInput, false);
  assert.equal(card.capabilities.maxImages, 1);
  assert.equal(card.capabilities.negativePrompt, false);
  assert.match(card.license!, /Non-Commercial/);
  const view = await library.view();
  const entry = view.models.find(model => model.id === card.id)!;
  assert.equal(entry.downloadable, true);
  assert.equal(entry.installed, false);
  assert.equal(entry.enabled, false);
  assert.equal(view.download, null);
  assert.deepEqual(entry.artifacts.map(artifact => artifact.role), ["diffusion", "diffusion-unconditional", "text-encoder", "vae"]);
  for (const artifact of card.artifacts) {
    assert.match(huggingFaceFile(artifact.source), /^https:\/\/huggingface\.co\/Comfy-Org\/Ideogram-4\/resolve\/2aa6c75ce6d5fabded0ca4d0f76abbfaf8edc87d\//);
    assert.match(artifact.sha256!, /^[a-f0-9]{64}$/);
  }
  const settings = settingsView(store);
  const configuration = settings.modelConfigurations.find(model => model.modelId === card.id)!;
  assert.deepEqual(configuration.memory, { ramBytes: 48 * GiB, vramBytes: 28 * GiB, source: "estimate" });
  assert.deepEqual(settings.modelConfigurations.filter(model => model.modelId !== card.id), previous.modelConfigurations);
  store.saveSettings(validateSettings(settings, inventory(), modelRegistry(store)));
  configuration.artifacts["diffusion-unconditional"] = "local/unconditional.safetensors";
  const resolved = configuredModel(configuration, store);
  assert.equal(resolved.artifacts.find(artifact => artifact.role === "diffusion-unconditional")!.sha256, undefined);
  assert.equal(resolved.artifacts.find(artifact => artifact.role === "diffusion")!.sha256, card.artifacts[0].sha256);
});

test("Ideogram downloads both diffusion roles and reuses the matching shared VAE", async t => {
  const requests: string[] = [];
  const { directory, store, library } = await fixture(t, { fetch: async input => { requests.push(String(input)); return response(); } });
  // Tiny verified safetensors exercise the real downloader without model weights.
  const model = structuredClone(getModel("ideogram-4-fp8"));
  model.id = "fixture-ideogram";
  model.artifacts = model.artifacts.map(artifact => ({ ...artifact, sha256 }));
  saveImportedModel(store, model);
  await mkdir(join(directory, "models", "vae"), { recursive: true });
  await writeFile(join(directory, "models", "vae", "flux2-vae.safetensors"), bytes);
  library.start({ modelId: model.id }); await library.waitForIdle();
  const view = await library.view();
  assert.equal(view.download?.status, "succeeded", view.download?.error ?? "Ideogram download should complete");
  assert.equal(requests.length, 3);
  assert.equal(requests.some(url => url.includes("/vae/")), false);
  assert.equal(requests.filter(url => url.includes("/diffusion_models/")).length, 2);
  for (const artifact of model.artifacts) assert.deepEqual(await readFile(join(directory, "models", artifact.folder, artifact.filename)), bytes);
  assert.equal(view.models.find(entry => entry.id === model.id)!.installed, true);
  assert.equal(view.models.find(entry => entry.id === model.id)!.enabled, false);
});

test("denied Ideogram model access stops without trying another source or activating the model", async t => {
  for (const status of [401, 403]) await t.test(String(status), async t => {
    let requests = 0;
    const { library } = await fixture(t, { fetch: async () => { requests++; return new Response(null, { status }); } });
    library.start({ modelId: "ideogram-4-fp8" }); await library.waitForIdle();
    const view = await library.view();
    assert.equal(requests, 1);
    assert.equal(view.download?.status, "failed");
    assert.match(view.download!.error!, /access|permission|license|token/i);
    assert.equal(view.models.find(model => model.id === "ideogram-4-fp8")!.enabled, false);
  });
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

test("saved Hugging Face credentials override HF_TOKEN and stay off redirected storage hosts", async t => {
  const previous = process.env.HF_TOKEN; process.env.HF_TOKEN = "fixture-legacy-token";
  t.after(() => { if (previous === undefined) delete process.env.HF_TOKEN; else process.env.HF_TOKEN = previous; });
  let vault: CredentialVault;
  const calls: { host: string; authorization: string | null }[] = [];
  const { store, library } = await fixture(t, {
    huggingFaceToken: () => vault.get("huggingface"),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ host: url.hostname, authorization: new Headers(init?.headers).get("Authorization") });
      return url.hostname === "huggingface.co" ? new Response(null, { status: 302, headers: { location: "https://us.aws.cdn.hf.co/fixture?signature=fixture" } }) : response();
    },
  });
  vault = new CredentialVault(store);
  vault.set("huggingface", "fixture-saved-private-token");
  library.start(importRequest); await library.waitForIdle();
  assert.equal((await library.view()).download?.status, "succeeded");
  assert.deepEqual(calls, [{ host: "huggingface.co", authorization: "Bearer fixture-saved-private-token" }, { host: "us.aws.cdn.hf.co", authorization: null }]);
  assert.equal(JSON.stringify(await library.view()).includes("fixture-saved-private-token"), false);
});

test("an unreadable saved credential stops model downloading without falling back to another token", async t => {
  const previous = process.env.HF_TOKEN; process.env.HF_TOKEN = "fixture-legacy-token";
  t.after(() => { if (previous === undefined) delete process.env.HF_TOKEN; else process.env.HF_TOKEN = previous; });
  let vault: CredentialVault;
  const { store, library } = await fixture(t, { huggingFaceToken: () => vault.get("huggingface"), fetch: async () => assert.fail("Unreadable credentials must not contact the provider") });
  vault = new CredentialVault(store);
  vault.set("huggingface", "fixture-saved-private-token");
  store.db.prepare("UPDATE integration_credentials SET tag=? WHERE provider='huggingface'").run(Buffer.alloc(16));
  library.start(importRequest); await library.waitForIdle();
  const view = await library.view();
  assert.equal(view.download?.status, "failed");
  assert.match(view.download?.error ?? "", /could not be unlocked/);
  assert.equal(JSON.stringify(view).includes("fixture-saved-private-token"), false);
  assert.equal(JSON.stringify(view).includes("fixture-legacy-token"), false);
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

test("activation and download preserve manual worker choices, including disabled GPUs", async t => {
  const fixture = await engineFixture({ count: 3, location: "local" }); t.after(fixture.close);
  const library = new ModelLibrary(fixture.store, fixture.engine, { fetch: async () => response() }); t.after(() => library.close());
  await mkdir(join(fixture.directory, "runtime"));
  await writeFile(join(fixture.directory, "runtime", "plan.json"), JSON.stringify({ workers: fixture.store.settings().workers }));
  const started = library.start(importRequest); await library.waitForIdle();
  const imported = modelRegistry(fixture.store).find(model => model.id === started.modelId)!;
  for (const worker of fixture.workers) {
    worker.state.info.CheckpointLoaderSimple.input!.required!.ckpt_name = [[imported.artifacts[0].filename]];
    const previous = worker.state.responseOverride;
    worker.state.responseOverride = path => path === "/models/checkpoints" ? { body: JSON.stringify([imported.artifacts[0].filename]) } : previous?.(path);
  }
  const settings = settingsView(fixture.store);
  settings.workers[1].enabled = false;
  const configuration = settings.modelConfigurations.find(model => model.modelId === imported.id)!;
  configuration.workerSelection = "manual";
  configuration.workerIds = ["worker-1", "worker-2"];
  fixture.store.saveSettings(validateSettings(settings, fixture.hardware, modelRegistry(fixture.store)));

  await library.activate({ modelId: imported.id });
  let saved = fixture.store.settings().modelConfigurations.find(model => model.modelId === imported.id)!;
  assert.equal(saved.enabled, true);
  assert.equal(saved.workerSelection, "manual");
  assert.deepEqual(saved.workerIds, ["worker-1", "worker-2"], "activation cannot add an unselected active GPU or drop a disabled selection");
  library.start({ modelId: imported.id }); await library.waitForIdle();
  assert.equal((await library.view()).download?.status, "succeeded");
  saved = fixture.store.settings().modelConfigurations.find(model => model.modelId === imported.id)!;
  assert.equal(saved.workerSelection, "manual");
  assert.deepEqual(saved.workerIds, ["worker-1", "worker-2"]);

  const disabled = fixture.store.settings();
  disabled.workers[2].enabled = false;
  fixture.store.saveSettings(disabled);
  await assert.rejects(library.activate({ modelId: imported.id }), { code: "MODEL_WORKER_UNAVAILABLE" });
  assert.deepEqual(fixture.store.settings().modelConfigurations.find(model => model.modelId === imported.id)?.workerIds, ["worker-1", "worker-2"]);
  assert.equal((await fixture.engine.catalog()).models.find(model => model.id === imported.id)?.ready, false, "an unselected ready GPU cannot serve a manual selection");
});

test("activation does not overwrite a worker selection changed during discovery", async t => {
  const { store, library } = await fixture(t);
  const started = library.start(importRequest); await library.waitForIdle();
  const settings = settingsView(store);
  settings.workers = [{ id: "managed-a", name: "GPU A", baseUrl: "http://127.0.0.1:8188", enabled: true, location: "local", deviceIds: ["gpu-0"], maxConcurrentJobs: 1 }];
  store.saveSettings(settings);
  await mkdir(join(store.directory, "runtime"));
  await writeFile(join(store.directory, "runtime", "plan.json"), JSON.stringify({ workers: settings.workers }));
  const concurrent = new ModelLibrary(store, {
    invalidateWorkers() {},
    async refreshWorkers() {
      const latest = settingsView(store);
      const model = latest.modelConfigurations.find(model => model.modelId === started.modelId)!;
      model.workerSelection = "manual"; model.workerIds = [];
      store.saveSettings(latest);
    },
    availableWorkers: () => store.settings().workers,
  });
  t.after(() => concurrent.close());
  await assert.rejects(concurrent.activate({ modelId: started.modelId }), { code: "MODEL_SETTINGS_CHANGED" });
  const preserved = store.settings().modelConfigurations.find(model => model.modelId === started.modelId)!;
  assert.equal(preserved.workerSelection, "manual");
  assert.deepEqual(preserved.workerIds, []);
  assert.equal(preserved.enabled, false);
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

test("LoRA imports pin their digest, stay outside the image picker and survive restart", async t => {
  const { directory, store, library } = await fixture(t);
  const job = library.start({ ...importRequest, kind: "lora" });
  await library.waitForIdle();
  assert.equal((await library.view()).download?.status, "succeeded");
  const extension = generationExtensionRegistry(store).find(item => item.id === job.modelId)!;
  assert.deepEqual(extension.familyIds, ["sdxl"]);
  assert.equal(extension.artifacts[0].sha256, sha256);
  assert.equal(extension.artifacts[0].folder, "loras");
  assert.equal(modelRegistry(store).some(model => model.id === extension.id), false);
  assert.equal(settingsView(store).modelConfigurations.some(model => model.modelId === extension.id), false);
  const card = (await library.view()).models.find(item => item.id === extension.id)!;
  assert.equal(card.installed, true); assert.equal(card.source, "huggingface");
  const reopened = new Store(directory);
  try { assert.deepEqual(generationExtensionRegistry(reopened).find(item => item.id === extension.id), extension); }
  finally { reopened.close(); }
  assert.deepEqual(await readFile(join(directory, "models", "loras", extension.artifacts[0].filename)), bytes);
});

test("LoRA imports reject unsupported families and malformed files without reporting installed", async t => {
  const { store, library } = await fixture(t, { fetch: async () => response(Buffer.from("invalid-safetensors")) });
  for (const familyId of ["ideogram-4", "unknown", "../../checkpoints"]) assert.throws(() => library.start({ ...importRequest, kind: "lora", familyId }), { code: "INVALID_MODEL_REQUEST" });
  const before = generationExtensionRegistry(store).length;
  const job = library.start({ ...importRequest, kind: "lora", familyId: "qwen-image-2.1" });
  await library.waitForIdle();
  const view = await library.view();
  assert.equal(view.download?.status, "failed");
  assert.equal(view.models.find(item => item.id === job.modelId)?.installed, false);
  assert.equal(generationExtensionRegistry(store).length, before + 1, "The failed import remains retryable without acquiring an image model configuration");
});
