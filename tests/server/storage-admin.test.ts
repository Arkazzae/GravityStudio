import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { initializeObjectBucket } from "../../apps/server/storage-admin.ts";
import type { S3ObjectStoreConfig } from "../../apps/server/object-store.ts";

interface Request { method: string; key: string; headers: IncomingHttpHeaders; body: Buffer }
async function fixture(t: TestContext, options: { exists?: boolean; canCreate?: boolean; publicScope?: "inputs" | "outputs"; failSignedPut?: boolean; region?: string } = {}) {
  const unrelated = "/gravity-studio/unrelated/keep";
  const objects = new Map([[unrelated, Buffer.from("existing unrelated asset")]]);
  const requests: Request[] = [];
  const state = { exists: options.exists ?? true, creations: 0 };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const entry = { method: request.method!, key: new URL(request.url!, "http://fixture").pathname, headers: request.headers, body: Buffer.concat(chunks) };
    requests.push(entry);
    const error = (code: string, status: number) => {
      response.writeHead(status, { "Content-Type": "application/xml" });
      response.end(`<Error><Code>${code}</Code><Message>fixture-secret-key private provider diagnostic</Message></Error>`);
    };
    if (entry.key.replace(/\/$/, "") === "/gravity-studio") {
      if (!entry.headers.authorization) return error("AccessDenied", 403);
      if (entry.method === "HEAD") { response.writeHead(state.exists ? 200 : 404); response.end(); return; }
      if (entry.method === "PUT") {
        if (options.canCreate === false) return error("AccessDenied", 403);
        state.exists = true; state.creations++; response.writeHead(200); response.end(); return;
      }
    }
    if (!state.exists) return error("NoSuchBucket", 404);
    if (entry.method === "GET") {
      if (!entry.headers.authorization && !entry.key.startsWith(`/gravity-studio/media-v1/${options.publicScope}/`)) return error("AccessDenied", 403);
      const bytes = objects.get(entry.key); if (!bytes) return error("NoSuchKey", 404);
      response.writeHead(200, { "Content-Length": bytes.length }); response.end(bytes); return;
    }
    if (!entry.headers.authorization) return error("AccessDenied", 403);
    if (entry.method === "PUT") {
      if (options.failSignedPut) return error("AccessDenied", 403);
      if (objects.has(entry.key)) return error("PreconditionFailed", 412);
      objects.set(entry.key, entry.body); response.writeHead(200); response.end(); return;
    }
    if (entry.method === "DELETE") { objects.delete(entry.key); response.writeHead(204); response.end(); return; }
    error("MethodNotAllowed", 405);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const config: S3ObjectStoreConfig = { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, region: options.region ?? "us-east-1", bucket: "gravity-studio", prefix: "media-v1", accessKeyId: "fixture-access-key", secretAccessKey: "fixture-secret-key", timeoutMs: 1000 };
  const writes = () => requests.filter(request => request.method === "PUT" && request.key.startsWith("/gravity-studio/media-v1/"));
  function clean() {
    assert.deepEqual([...objects], [[unrelated, Buffer.from("existing unrelated asset")]], "qualification removes only its own temporary objects");
    assert.deepEqual(requests.filter(request => request.method === "DELETE").map(request => request.key), writes().map(request => request.key));
  }
  return { config, requests, objects, state, writes, clean };
}

test("storage initialization creates a missing bucket and qualifies both private asset scopes", async t => {
  const f = await fixture(t, { exists: false });
  await initializeObjectBucket(f.config);
  assert.equal(f.state.creations, 1); assert.equal(f.state.exists, true);
  assert.equal(f.writes().length, 2);
  assert.ok(f.writes()[0].key.startsWith("/gravity-studio/media-v1/inputs/"));
  assert.ok(f.writes()[1].key.startsWith("/gravity-studio/media-v1/outputs/"));
  const anonymous = f.requests.filter(request => request.method === "GET" && !request.headers.authorization);
  assert.deepEqual(anonymous.map(request => request.key), f.writes().map(request => request.key));
  for (const request of f.requests.filter(request => request.headers.authorization)) {
    assert.match(request.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=fixture-access-key\//);
    assert.ok(!JSON.stringify(request.headers).includes(f.config.secretAccessKey));
  }
  f.clean();
});

test("an existing bucket can be qualified with a scoped key that cannot create buckets", async t => {
  const f = await fixture(t, { canCreate: false });
  await initializeObjectBucket(f.config);
  assert.equal(f.state.creations, 0);
  assert.equal(f.requests.some(request => request.method === "PUT" && request.key.replace(/\/$/, "") === "/gravity-studio"), false);
  assert.equal(f.writes().length, 2); f.clean();
});

test("bucket creation uses the configured nondefault S3 region", async t => {
  const f = await fixture(t, { exists: false, region: "us-west-2" });
  await initializeObjectBucket(f.config);
  const creation = f.requests.find(request => request.method === "PUT" && request.key.replace(/\/$/, "") === "/gravity-studio")!;
  assert.match(creation.body.toString(), /<LocationConstraint>us-west-2<\/LocationConstraint>/);
  assert.equal(f.state.creations, 1); f.clean();
});

for (const publicScope of ["inputs", "outputs"] as const) {
  test(`storage initialization rejects anonymous ${publicScope} reads and cleans its qualification objects`, async t => {
    const f = await fixture(t, { publicScope });
    await assert.rejects(initializeObjectBucket(f.config), /Could not initialize and verify the private S3 bucket/);
    assert.equal(f.writes().length, publicScope === "inputs" ? 1 : 2);
    assert.ok(f.requests.some(request => !request.headers.authorization && request.key.startsWith(`/gravity-studio/media-v1/${publicScope}/`)));
    f.clean();
  });
}

test("signed storage initialization errors do not expose provider details or credentials", async t => {
  const f = await fixture(t, { failSignedPut: true });
  await assert.rejects(initializeObjectBucket(f.config), error => {
    const value = error as Error;
    assert.match(value.message, /Check the endpoint, credentials and bucket permissions/);
    for (const sensitive of [f.config.secretAccessKey, f.config.accessKeyId, f.config.endpoint, "private provider diagnostic"]) assert.ok(!value.message.includes(sensitive));
    assert.equal(value.cause, undefined); return true;
  });
  assert.equal(f.objects.size, 1);
  assert.equal(f.writes().length, 1);
});
