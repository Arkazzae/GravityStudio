import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { S3ObjectStore, objectStoreFromEnv, s3ObjectStoreConfig, type StoredObject } from "../../apps/server/object-store.ts";

const payload = Buffer.from("private image fixture bytes");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const location = `outputs/${randomUUID()}/${"a".repeat(32)}`;
const credentials = { NODE_ENV: "test" as const, GRAVITY_S3_ACCESS_KEY_ID: "fixture-access-key", GRAVITY_S3_SECRET_ACCESS_KEY: "fixture-secret-key" };
interface Request { method: string; key: string; headers: IncomingHttpHeaders; body: Buffer }
async function fixture(t: TestContext, timeoutMs = 30_000) {
  const objects = new Map<string, Buffer>();
  const requests: Request[] = [];
  const state = { commits: 0, dropAcknowledgement: false, corruptWrites: false,
    override: undefined as ((request: Request, response: ServerResponse) => boolean | Promise<boolean>) | undefined };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const entry = { method: request.method!, key: new URL(request.url!, "http://fixture").pathname, headers: request.headers, body: Buffer.concat(chunks) };
    requests.push(entry);
    if (await state.override?.(entry, response)) return;
    const error = (code: string, status: number) => { response.writeHead(status, { "Content-Type": "application/xml" }); response.end(`<Error><Code>${code}</Code><Message>private provider diagnostic fixture-secret-key</Message></Error>`); };
    if (entry.method === "GET") {
      const bytes = objects.get(entry.key); if (!bytes) return error("NoSuchKey", 404);
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length }); response.end(bytes); return;
    }
    if (entry.method === "PUT") {
      assert.equal(entry.headers["if-none-match"], "*");
      if (objects.has(entry.key)) return error("PreconditionFailed", 412);
      objects.set(entry.key, state.corruptWrites ? Buffer.alloc(entry.body.length) : entry.body); state.commits++;
      if (state.dropAcknowledgement) { request.socket.destroy(); return; }
      response.writeHead(200, { ETag: '"fixture-etag-is-not-a-content-hash"' }); response.end(); return;
    }
    if (entry.method === "DELETE") { objects.delete(entry.key); response.writeHead(204); response.end(); return; }
    error("MethodNotAllowed", 405);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = s3ObjectStoreConfig({ ...credentials, GRAVITY_S3_ENDPOINT: endpoint, GRAVITY_S3_TIMEOUT_MS: String(timeoutMs) });
  const store = new S3ObjectStore(config);
  t.after(async () => { store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const ref = (data = payload): StoredObject => ({ backend: "s3", storeId: store.id, key: `media-v1/${location}/${hash(data)}`, sha256: hash(data), bytes: data.length });
  return { store, config, objects, requests, state, endpoint, ref };
}

test("S3 configuration is explicit, private and independent of credential rotation", () => {
  assert.equal(objectStoreFromEnv({ NODE_ENV: "test" }), null);
  assert.equal(objectStoreFromEnv({ NODE_ENV: "test", GRAVITY_ASSET_STORAGE: "local", GRAVITY_S3_ENDPOINT: "invalid" }), null);
  assert.throws(() => objectStoreFromEnv({ NODE_ENV: "test", GRAVITY_ASSET_STORAGE: "dual-write" }));
  const env = { ...credentials, GRAVITY_S3_ENDPOINT: "http://localhost:9000" };
  const config = s3ObjectStoreConfig(env);
  assert.equal(config.bucket, "gravity-studio"); assert.equal(config.prefix, "media-v1"); assert.equal(config.region, "us-east-1"); assert.equal(config.timeoutMs, 30_000);
  for (const patch of [
    { GRAVITY_S3_ENDPOINT: "http://remote.example:9000" }, { GRAVITY_S3_ENDPOINT: "https://user:secret@example.com" },
    { GRAVITY_S3_ENDPOINT: "https://example.com/prefix" }, { GRAVITY_S3_ENDPOINT: "https://example.com/?key=secret" },
    { GRAVITY_S3_ENDPOINT: "https://example.com/#fragment" }, { GRAVITY_S3_ENDPOINT: "file:///tmp/object" },
    { GRAVITY_S3_BUCKET: "../private" }, { GRAVITY_S3_BUCKET: "127.0.0.1" }, { GRAVITY_S3_BUCKET: "bucket..name" },
    { GRAVITY_S3_REGION: "region/invalid" }, { GRAVITY_S3_PREFIX: "../private" }, { GRAVITY_S3_PREFIX: "media//v1" },
    { GRAVITY_S3_PREFIX: "media/" }, { GRAVITY_S3_PREFIX: "x".repeat(129) }, { GRAVITY_S3_SECRET_ACCESS_KEY: "" },
    { GRAVITY_S3_ACCESS_KEY_ID: "" }, { GRAVITY_S3_TIMEOUT_MS: "999" }, { GRAVITY_S3_TIMEOUT_MS: "120001" }, { GRAVITY_S3_TIMEOUT_MS: "NaN" },
  ]) assert.throws(() => s3ObjectStoreConfig({ ...env, ...patch }));
  assert.throws(() => s3ObjectStoreConfig({ NODE_ENV: "test", GRAVITY_S3_ENDPOINT: env.GRAVITY_S3_ENDPOINT, AWS_ACCESS_KEY_ID: "ambient", AWS_SECRET_ACCESS_KEY: "ambient" }), /explicit/);
  const original = new S3ObjectStore(config), rotated = new S3ObjectStore({ ...config, accessKeyId: "rotated-key", secretAccessKey: "rotated-secret" });
  try {
    assert.match(original.id, /^[a-f0-9]{64}$/); assert.equal(original.id, rotated.id);
    for (const patch of [{ endpoint: "https://another.example" }, { bucket: "another-bucket" }, { prefix: "another-prefix" }, { region: "us-west-2" }]) {
      const changed = new S3ObjectStore({ ...config, ...patch });
      try { assert.notEqual(original.id, changed.id); } finally { changed.close(); }
    }
  } finally { original.close(); rotated.close(); }
});

test("the real S3 signer writes content-bound objects, verifies bytes and reads after restart", async t => {
  const f = await fixture(t);
  const ref = await f.store.put(location, payload, "image/png");
  assert.deepEqual(ref, f.ref()); assert.equal(f.state.commits, 1);
  const write = f.requests.find(request => request.method === "PUT")!;
  assert.equal(write.key, `/gravity-studio/${ref.key}`);
  assert.match(write.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=fixture-access-key\//);
  assert.equal(write.headers["content-type"], "image/png"); assert.equal(write.headers["content-length"], String(payload.length));
  assert.equal(write.headers["x-amz-meta-sha256"], ref.sha256); assert.equal(write.headers["x-amz-content-sha256"], ref.sha256);
  assert.ok(!JSON.stringify(write.headers).includes(credentials.GRAVITY_S3_SECRET_ACCESS_KEY));
  assert.ok(!JSON.stringify(ref).includes(f.endpoint)); assert.ok(!JSON.stringify(ref).includes("fixture-access-key"));
  assert.deepEqual(await f.store.get(ref, 1024), payload);
  const reopened = new S3ObjectStore(f.config);
  try { assert.deepEqual(await reopened.get(ref, 1024), payload); } finally { reopened.close(); }
  assert.deepEqual(await f.store.put(location, payload, "image/png"), ref); assert.equal(f.state.commits, 1);
  await f.store.delete(ref); await f.store.delete(ref);
  assert.equal(f.objects.size, 0);
  await assert.rejects(f.store.get(ref, 1024), { code: "ASSET_READ_FAILED", status: 503 });
});

test("concurrent identical puts and lost acknowledgements verify the committed object", async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.store.put(location, payload, "image/png"), f.store.put(location, payload, "image/png")]);
  assert.deepEqual(first, second); assert.equal(f.state.commits, 1);
  f.state.dropAcknowledgement = true;
  const different = Buffer.from("another original image");
  const next = await f.store.put(location, different, "image/png");
  assert.notEqual(first.key, next.key); assert.equal(f.state.commits, 2);
  assert.deepEqual(await f.store.get(first, 1024), payload); assert.deepEqual(await f.store.get(next, 1024), different);
});

test("S3 publication never accepts matching metadata with corrupted content", async t => {
  const f = await fixture(t);
  f.state.corruptWrites = true;
  await assert.rejects(f.store.put(location, payload, "image/png"), { code: "ASSET_INTEGRITY_ERROR", status: 503 });
  assert.equal(f.state.commits, 1);
  await assert.rejects(f.store.put(location, payload, "image/png"), { code: "ASSET_INTEGRITY_ERROR", status: 503 });
  assert.equal(f.state.commits, 1, "an existing corrupt object is never overwritten");
  await assert.rejects(f.store.get(f.ref(), 1024), { code: "ASSET_INTEGRITY_ERROR", status: 503 });
  f.objects.set(`/gravity-studio/${f.ref().key}`, Buffer.from("truncated"));
  await assert.rejects(f.store.get(f.ref(), 1024), { code: "ASSET_INTEGRITY_ERROR" });
});

test("invalid locations, cross-store references and read limits fail before network access", async t => {
  const f = await fixture(t);
  for (const path of ["inputs/../private", "inputs//private", "inputs/not-a-uuid", `${location}/../other`, `/${location}`, `${location}/${hash(payload)}`]) await assert.rejects(f.store.put(path, payload, "image/png"), { code: "INVALID_ASSET_KEY" });
  await assert.rejects(f.store.put(location, new Uint8Array(), "image/png"), { code: "ASSET_TOO_LARGE" });
  await assert.rejects(f.store.put(location, new Uint8Array(64 * 1024 ** 2 + 1), "image/png"), { code: "ASSET_TOO_LARGE" });
  await assert.rejects(f.store.put(location, payload, "image/png\r\nAuthorization: secret"), { code: "INVALID_ASSET_TYPE" });
  for (const ref of [{ ...f.ref(), storeId: "another-store" }, { ...f.ref(), key: "outside-prefix/object" }, { ...f.ref(), key: `media-v1/../${hash(payload)}` }, { ...f.ref(), sha256: "0".repeat(64) }, { ...f.ref(), bytes: 0 }]) {
    await assert.rejects(f.store.get(ref, 1024)); await assert.rejects(f.store.delete(ref));
  }
  await assert.rejects(f.store.get(f.ref(), payload.length - 1), { code: "ASSET_TOO_LARGE" });
  await assert.rejects(f.store.get(f.ref(), Infinity), { code: "ASSET_TOO_LARGE" });
  assert.equal(f.requests.length, 0);
  const input = await f.store.put(`inputs/${randomUUID()}`, payload, "image/png");
  assert.ok(input.key.startsWith("media-v1/inputs/"));
});

test("provider errors and malformed delete acknowledgements stay private", async t => {
  const f = await fixture(t);
  f.state.override = (request, response) => {
    response.writeHead(request.method === "DELETE" ? 200 : 403, { "Content-Type": "application/xml" });
    response.end("<Error><Code>AccessDenied</Code><Message>fixture-secret-key private provider diagnostic</Message></Error>"); return true;
  };
  for (const work of [() => f.store.put(location, payload, "image/png"), () => f.store.get(f.ref(), 1024), () => f.store.delete(f.ref())]) {
    await assert.rejects(work(), error => {
      const value = error as Error & { status: number };
      assert.equal(value.status, 503); assert.ok(!value.message.includes("fixture-secret-key")); assert.ok(!value.message.includes("provider diagnostic")); return true;
    });
  }
  assert.equal(f.state.commits, 0);
  f.state.override = (_request, response) => { response.writeHead(404, { "Content-Type": "application/xml" }); response.end("<Error><Code>NoSuchKey</Code></Error>"); return true; };
  await f.store.delete(f.ref());
  f.state.override = (_request, response) => { response.writeHead(404, { "Content-Type": "application/xml" }); response.end("<Error><Code>NoSuchBucket</Code></Error>"); return true; };
  await assert.rejects(f.store.delete(f.ref()), { code: "ASSET_DELETE_FAILED" });
});

test("S3 redirects never forward signed requests to another endpoint", async t => {
  const f = await fixture(t), target = await fixture(t);
  f.state.override = (_request, response) => { response.writeHead(302, { Location: target.endpoint }); response.end(); return true; };
  await assert.rejects(f.store.get(f.ref(), 1024), { code: "ASSET_READ_FAILED" });
  assert.equal(target.requests.length, 0);
});

test("provider error bodies are bounded before SDK XML parsing", async t => {
  const f = await fixture(t);
  f.state.override = (_request, response) => {
    response.writeHead(503, { "Content-Type": "application/xml" });
    response.write("<Error><Code>SlowDown</Code><Message>");
    response.end("x".repeat(70 * 1024)); return true;
  };
  await assert.rejects(f.store.get(f.ref(), 1024), { code: "ASSET_STORAGE_RESPONSE_INVALID", status: 503 });
  assert.equal(f.requests.length, 1, "provider failures do not trigger SDK retry loops");
});

test("the operation deadline covers both response headers and a stalled response body", async t => {
  const f = await fixture(t, 1000);
  for (const headers of [false, true]) {
    f.state.override = (_request, response) => {
      if (headers) { response.writeHead(200, { "Content-Length": payload.length }); response.write(payload.subarray(0, 1)); }
      return true;
    };
    const started = Date.now();
    await assert.rejects(f.store.get(f.ref(), 1024), { code: "ASSET_STORAGE_TIMEOUT", status: 503 });
    assert.ok(Date.now() - started < 3000);
  }
});

test("closing object storage cancels pending reads and prevents new operations", async t => {
  const f = await fixture(t);
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  f.state.override = (_request, response) => { response.writeHead(200, { "Content-Length": payload.length }); response.write(payload.subarray(0, 1)); entered(); return true; };
  const read = f.store.get(f.ref(), 1024);
  await started; f.store.close();
  await assert.rejects(read, { code: "ASSET_STORAGE_TIMEOUT" });
  await assert.rejects(f.store.get(f.ref(), 1024), { code: "ASSET_STORAGE_CLOSED" });
  await assert.rejects(f.store.put(location, payload, "image/png"), { code: "ASSET_STORAGE_CLOSED" });
});
