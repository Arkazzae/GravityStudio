import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../../apps/server/auth.ts";
import { Engine } from "../../apps/server/engine.ts";
import { createStudioServer } from "../../apps/server/http.ts";
import { ModelLibrary, huggingFaceFile } from "../../apps/server/models.ts";
import { modelRegistry } from "../../apps/server/registry.ts";
import { Store } from "../../apps/server/store.ts";
import { getModelPresets } from "../../packages/inference/model-presets.ts";

function longFileUrl(role: string): string {
  const directory = encodeURIComponent("木".repeat(200));
  const base = `https://huggingface.co/example/http-fixture/resolve/main/${directory}/${role}.safetensors`;
  const url = base.replace(`/${role}.safetensors`, `${"a".repeat(2048 - base.length)}/${role}.safetensors`);
  assert.equal(url.length, 2048);
  assert.equal(huggingFaceFile(url), url);
  return url;
}

test("model import HTTP routes accept a complete four-file preset above 8 KiB and reject bodies above 32 KiB", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gravity-checkpoint-request-"));
  const store = new Store(directory);
  const owner = store.createOwner("owner", "fixture-password-hash");
  const engine = new Engine(store);
  const requests: string[] = [];
  const header = Buffer.from(JSON.stringify({ tensor: { dtype: "F32", shape: [1], data_offsets: [0, 4] } }));
  const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(header.length));
  const bytes = Buffer.concat([size, header, Buffer.alloc(4)]);
  const models = new ModelLibrary(store, { invalidateWorkers() {}, async refreshWorkers() {}, availableWorkers() { return []; } }, {
    fetch: async (_url, options) => {
      requests.push(options?.method ?? "GET");
      return options?.method === "HEAD" ? new Response(null) : new Response(bytes, { headers: { "Content-Length": String(bytes.length) } });
    },
  });
  const origin = "http://localhost:4321";
  const server = await createStudioServer({ store, engine, models, allowedOrigins: [origin], setupSecret: "checkpoint-fixture" });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await server.closeOperations(); await engine.stop(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); await rm(directory, { recursive: true, force: true });
  });
  const cookie = createSession(store, owner, false).split(";")[0];
  const post = (route: string, body: unknown) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/models/${route}`, {
    method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const preset = getModelPresets().find(item => item.id === "ideogram-4-fp8")!;
  const request = {
    presetId: preset.id, name: "Four-file checkpoint", url: longFileUrl(preset.primaryRole),
    dependencies: preset.dependencyRoles.map(role => ({ role, url: longFileUrl(role) })),
    operations: ["text-to-image"], defaults: preset.defaults,
  };
  assert.ok(Buffer.byteLength(JSON.stringify(request)) > 8192);
  assert.ok(Buffer.byteLength(JSON.stringify(request)) < 32 * 1024);

  const access = await post("access", request);
  assert.equal(access.status, 200);
  assert.equal((await access.json()).available, true);
  assert.deepEqual(requests, ["HEAD", "HEAD", "HEAD", "HEAD"]);
  assert.equal(modelRegistry(store).some(model => model.name === request.name), false);

  const download = await post("download", request);
  assert.equal(download.status, 202);
  const imported = await download.json();
  await models.waitForIdle();
  const view = await models.view();
  assert.equal(view.download?.status, "succeeded");
  assert.equal(view.download?.completedFiles, 4);
  assert.equal(view.models.find(model => model.id === imported.modelId)?.installed, true);
  assert.deepEqual(requests, ["HEAD", "HEAD", "HEAD", "HEAD", "GET", "GET", "GET", "GET"]);

  const oversized = { ...request, name: "a".repeat(32 * 1024) };
  for (const route of ["access", "download"]) {
    const rejected = await post(route, oversized);
    assert.equal(rejected.status, 413, route);
    assert.equal((await rejected.json()).error.code, "REQUEST_TOO_LARGE", route);
  }
  assert.equal(requests.length, 8, "Oversized requests never reach Hugging Face");
});
