import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ApiError } from "../../packages/contracts/index.ts";
import { Store } from "../../apps/server/store.ts";
import { LOCAL_TEXT_MODEL, TextModelFiles, type TextModelProgress } from "../../apps/server/text-models.ts";

const bytes = Buffer.alloc(128, 42);
bytes.write("GGUF", 0); bytes.writeUInt32LE(3, 4); bytes.writeBigUInt64LE(1n, 8); bytes.writeBigUInt64LE(1n, 16);
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const artifact = { ...LOCAL_TEXT_MODEL, filename: "fixture.gguf", sizeBytes: bytes.length, sha256: digest(bytes) };
const response = (data: Uint8Array = bytes, headers: Record<string, string> = { "content-length": String(data.length) }) => new Response(Uint8Array.from(data), { headers });
type Options = NonNullable<ConstructorParameters<typeof TextModelFiles>[1]>;
async function fixture(t: TestContext, options: Options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gravity-text-files-"));
  const store = new Store(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const defaults: Options = { model: artifact, fetch: async () => response(), availableBytes: async () => 20 * 1024 ** 3, huggingFaceToken: () => undefined };
  const files = new TextModelFiles(store, { ...defaults, ...options });
  return { directory, store, files, defaults };
}
const signal = () => new AbortController().signal;
const ignore = () => {};
async function clean(files: TextModelFiles): Promise<void> {
  assert.equal(await files.installed(), false);
  assert.deepEqual(await readdir(dirname(files.path)), []);
}

test("the managed MiMo artifact pins the official Q8_0 bytes and a bounded context", () => {
  assert.equal(LOCAL_TEXT_MODEL.id, "mimo-v2.6-distill-qwen-9b");
  assert.equal(LOCAL_TEXT_MODEL.sizeBytes, 9_527_498_048);
  assert.equal(LOCAL_TEXT_MODEL.contextTokens, 8192);
  assert.equal(LOCAL_TEXT_MODEL.sha256, "de6dae10334e088876358ef9f574835bb3b401ea2ecf5d6a9473f37894df6b73");
  assert.equal(LOCAL_TEXT_MODEL.downloadUrl, "https://huggingface.co/ggml-org/MiMo-V2.6-Distill-Qwen-9B-GGUF/resolve/81baddc39bc48924a88e87b8d31aceb03058e559/MiMo-V2.6-Distill-Qwen-9B-Q8_0.gguf");
  assert.ok(Object.isFrozen(LOCAL_TEXT_MODEL));
});

test("download publishes only complete verified bytes and later checks reuse the existing file", async t => {
  let requests = 0;
  const { files, store, defaults } = await fixture(t, { fetch: async () => { requests += 1; assert.equal(await files.installed(), false); return response(); } });
  assert.equal(await files.installed(), false);
  const progress: TextModelProgress[] = [];
  await files.download(signal(), value => { progress.push(value); });
  assert.equal(await files.installed(), true);
  assert.deepEqual(await readFile(files.path), bytes);
  assert.deepEqual(await readdir(dirname(files.path)), [artifact.filename]);
  assert.deepEqual(progress[0], { receivedBytes: 0, totalBytes: bytes.length });
  assert.deepEqual(progress.at(-1), { receivedBytes: bytes.length, totalBytes: bytes.length });
  assert.ok(progress.every((item, index) => item.receivedBytes >= (progress[index - 1]?.receivedBytes ?? 0)));
  await files.download(signal(), ignore);
  assert.equal(requests, 1);
  assert.equal(await new TextModelFiles(store, defaults).installed(), true, "a new manager verifies persisted bytes");
});

test("chunked responses are bounded by the pinned size and headers can span body chunks", async t => {
  const { files } = await fixture(t, { fetch: async () => new Response(new ReadableStream({ start(controller) { for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.subarray(offset, offset + 7)); controller.close(); } })) });
  await files.download(signal(), ignore);
  assert.equal(await files.installed(), true);
});

test("matching pre-existing files are verified without downloading", async t => {
  const { files } = await fixture(t, { fetch: async () => assert.fail("Existing verified files must not be downloaded") });
  await mkdir(dirname(files.path), { recursive: true }); await writeFile(files.path, bytes);
  assert.equal(await files.installed(), true);
  await files.download(signal(), ignore);
});

test("a checksum mismatch removes only its own partial and permits a clean retry", async t => {
  const changed = Buffer.from(bytes); changed[64] ^= 1;
  let corrupted = true;
  const { files } = await fixture(t, { fetch: async () => response(corrupted ? changed : bytes) });
  await mkdir(dirname(files.path), { recursive: true });
  const foreignPartial = `${files.path}.foreign.partial`;
  await writeFile(foreignPartial, "unrelated unfinished file");
  await assert.rejects(files.download(signal(), ignore), { code: "TEXT_MODEL_CHECKSUM_MISMATCH" });
  assert.equal(await files.installed(), false);
  assert.deepEqual(await readdir(dirname(files.path)), ["fixture.gguf.foreign.partial"]);
  assert.equal(await readFile(foreignPartial, "utf8"), "unrelated unfinished file");
  corrupted = false; await files.download(signal(), ignore);
  assert.equal(await files.installed(), true);
});

test("foreign destination files are never overwritten, including same-size corrupt files", async t => {
  const { files } = await fixture(t, { fetch: async () => assert.fail("A conflicting file must stop before fetching") });
  await mkdir(dirname(files.path), { recursive: true });
  for (const data of [Buffer.from("foreign file"), Buffer.alloc(bytes.length, 99)]) {
    await writeFile(files.path, data);
    assert.equal(await files.installed(), false);
    await assert.rejects(files.download(signal(), ignore), { code: "TEXT_MODEL_FILE_CONFLICT", status: 409 });
    assert.deepEqual(await readFile(files.path), data);
  }
});

test("changing a previously verified file invalidates the cached verification", async t => {
  const { files, store, defaults } = await fixture(t);
  await files.download(signal(), ignore);
  const changed = Buffer.from(bytes); changed[80] ^= 1;
  await writeFile(files.path, changed);
  assert.equal(await files.installed(), false);
  assert.equal(await new TextModelFiles(store, defaults).installed(), false);
  await assert.rejects(files.download(signal(), ignore), { code: "TEXT_MODEL_FILE_CONFLICT" });
});

test("symlink destinations and directories cannot escape the managed model folder", async t => {
  const { files, directory } = await fixture(t, { fetch: async () => assert.fail("Unsafe directories must stop before fetching") });
  const elsewhere = join(directory, "elsewhere"); await mkdir(elsewhere);
  await writeFile(join(elsewhere, "valid.gguf"), bytes);
  await mkdir(dirname(files.path), { recursive: true });
  await symlink(join(elsewhere, "valid.gguf"), files.path);
  assert.equal(await files.installed(), false);
  await assert.rejects(files.download(signal(), ignore), { code: "TEXT_MODEL_FILE_CONFLICT" });
  await rm(dirname(files.path), { recursive: true });
  await symlink(elsewhere, dirname(files.path));
  assert.equal(await files.installed(), false);
  await assert.rejects(files.download(signal(), ignore), { code: "TEXT_MODEL_UNSAFE_DIRECTORY" });
  assert.deepEqual(await readdir(elsewhere), ["valid.gguf"]);
});

test("atomic publication leaves a destination created during download untouched", async t => {
  const { files } = await fixture(t, { fetch: async () => { await writeFile(files.path, "created concurrently"); return response(); } });
  await assert.rejects(files.download(signal(), ignore), { code: "TEXT_MODEL_FILE_CONFLICT" });
  assert.equal(await readFile(files.path, "utf8"), "created concurrently");
  assert.deepEqual(await readdir(dirname(files.path)), [artifact.filename]);
});

test("a symlinked ancestor is rejected before creating directories outside storage", async t => {
  const { files, directory } = await fixture(t, { fetch: async () => assert.fail("Unsafe storage must not fetch") });
  const elsewhere = join(directory, "elsewhere"); await mkdir(elsewhere);
  await symlink(elsewhere, join(directory, "models"));
  await assert.rejects(files.download(signal(), ignore), { code: "TEXT_MODEL_UNSAFE_DIRECTORY" });
  assert.deepEqual(await readdir(elsewhere), []);
});

test("Hugging Face credentials are sent only to its exact host, never storage redirects", async t => {
  const hosts = ["huggingface.co", "cas-bridge.xethub.hf.co", "us.aws.cdn.hf.co"];
  const calls: { host: string; authorization: string | null }[] = [];
  const { files } = await fixture(t, { huggingFaceToken: () => "private-test-token", fetch: async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("Accept-Encoding"), "identity");
    assert.ok(init?.signal instanceof AbortSignal);
    calls.push({ host: url.hostname, authorization: new Headers(init?.headers).get("Authorization") });
    const next = hosts[calls.length];
    return next ? new Response(null, { status: 302, headers: { location: `https://${next}/signed-model?signature=fixture` } }) : response();
  } });
  await files.download(signal(), ignore);
  assert.deepEqual(calls, hosts.map((host, index) => ({ host, authorization: index ? null : "Bearer private-test-token" })));
});

test("redirect allowlists reject local servers, lookalike domains, credentials and HTTP", async t => {
  for (const location of ["http://huggingface.co/file", "https://127.0.0.1/file", "https://huggingface.co.attacker.invalid/file", "https://user:secret@huggingface.co/file", "https://huggingface.co:8443/file"]) {
    let calls = 0;
    const { files } = await fixture(t, { fetch: async () => { calls += 1; return new Response(null, { status: 302, headers: { location } }); } });
    await assert.rejects(files.download(signal(), ignore), { code: "TEXT_MODEL_UNSAFE_REDIRECT" });
    assert.equal(calls, 1); await clean(files);
  }
});

test("access failures and redirect loops return safe errors and no artifact", async t => {
  for (const status of [401, 403, 404, 429, 500, 206]) {
    const { files } = await fixture(t, { fetch: async () => new Response("PRIVATE_UPSTREAM_DETAIL", { status }) });
    await assert.rejects(files.download(signal(), ignore), (error: unknown) => error instanceof ApiError && !`${error.message}${JSON.stringify(error)}`.includes("PRIVATE_UPSTREAM_DETAIL"));
    await clean(files);
  }
  let calls = 0;
  const { files } = await fixture(t, { fetch: async () => { calls += 1; return new Response(null, { status: 302, headers: { location: LOCAL_TEXT_MODEL.downloadUrl } }); } });
  await assert.rejects(files.download(signal(), ignore), { code: "TEXT_MODEL_REDIRECT_LIMIT" });
  assert.equal(calls, 8); await clean(files);
});

test("file size, encoding and GGUF version checks reject invalid downloads", async t => {
  const badMagic = Buffer.from(bytes); badMagic.write("HTML", 0);
  const badVersion = Buffer.from(bytes); badVersion.writeUInt32LE(99, 4);
  const noTensors = Buffer.from(bytes); noTensors.writeBigUInt64LE(0n, 8);
  for (const [data, headers, code] of [
    [bytes, { "content-length": "129" }, "INVALID_SIZE"],
    [bytes, { "content-length": "not-a-size" }, "INVALID_SIZE"],
    [bytes, { "content-encoding": "gzip" }, "INVALID_SIZE"],
    [bytes.subarray(0, 100), {}, "INCOMPLETE"],
    [Buffer.concat([bytes, bytes]), {}, "INVALID_SIZE"],
    [badMagic, {}, "INVALID_GGUF"], [badVersion, {}, "INVALID_GGUF"], [noTensors, {}, "INVALID_GGUF"],
  ] as const) {
    const { files } = await fixture(t, { fetch: async () => response(data, headers) });
    await assert.rejects(files.download(signal(), ignore), { code: `TEXT_MODEL_${code}` });
    await clean(files);
  }
});

test("insufficient free space stops before contacting Hugging Face", async t => {
  const { files } = await fixture(t, { availableBytes: async () => 1024 ** 3 + bytes.length - 1, fetch: async () => assert.fail("Do not fetch without the required disk reserve") });
  await assert.rejects(files.download(signal(), ignore), { code: "TEXT_MODEL_DISK_SPACE" });
  await clean(files);
});

test("cancellation closes a pending response and removes its partial", async t => {
  const controller = new AbortController(); let cancelled = false;
  const { files } = await fixture(t, { fetch: async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(bytes.subarray(0, 40)); }, cancel() { cancelled = true; } })) });
  await assert.rejects(files.download(controller.signal, progress => { if (progress.receivedBytes) controller.abort(); }), { code: "TEXT_MODEL_CANCELLED" });
  assert.equal(cancelled, true); await clean(files);
});

test("already cancelled requests do not fetch or create the model directory", async t => {
  const { files } = await fixture(t, { fetch: async () => assert.fail("Cancelled download must not fetch") });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(files.download(controller.signal, ignore), { code: "TEXT_MODEL_CANCELLED" });
  await assert.rejects(readdir(dirname(files.path)), { code: "ENOENT" });
});

test("inactivity timeout interrupts an uncooperative fetch and allows retry", async t => {
  let hang = true;
  const { files } = await fixture(t, { timeoutMs: 30, fetch: async () => hang ? await new Promise<Response>(() => {}) : response() });
  await assert.rejects(files.download(signal(), ignore), { code: "TEXT_MODEL_DOWNLOAD_TIMEOUT", status: 504 });
  await clean(files);
  hang = false; await files.download(signal(), ignore);
  assert.equal(await files.installed(), true);
});

test("inactivity timeout also interrupts stalled body reads", async t => {
  let cancelled = false;
  const { files } = await fixture(t, { timeoutMs: 30, fetch: async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(bytes.subarray(0, 40)); }, cancel() { cancelled = true; } })) });
  await assert.rejects(files.download(signal(), ignore), { code: "TEXT_MODEL_DOWNLOAD_TIMEOUT" });
  assert.equal(cancelled, true); await clean(files);
});

test("concurrent downloads are refused while the active operation remains cancellable", async t => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const { files } = await fixture(t, { fetch: async () => { started(); return await new Promise<Response>(() => {}); } });
  const controller = new AbortController();
  const first = files.download(controller.signal, ignore);
  const rejected = assert.rejects(first, { code: "TEXT_MODEL_CANCELLED" });
  await ready;
  await assert.rejects(files.download(signal(), ignore), { code: "TEXT_MODEL_DOWNLOAD_BUSY" });
  controller.abort(); await rejected; await clean(files);
});

test("transport exceptions never expose credentials, upstream addresses or causes", async t => {
  const sensitive = "PRIVATE_UPSTREAM_DETAIL";
  for (const thrown of [new Error(sensitive), new ApiError(502, sensitive, sensitive)]) {
    const { files } = await fixture(t, { fetch: async () => { throw thrown; } });
    await assert.rejects(files.download(signal(), ignore), (error: unknown) => error instanceof ApiError && !`${error.message}${JSON.stringify(error)}`.includes(sensitive) && error.cause === undefined);
    await clean(files);
  }
  const { files } = await fixture(t, { fetch: async () => new Response(new ReadableStream({ pull(controller) { controller.error(new ApiError(502, sensitive, sensitive)); } })) });
  await assert.rejects(files.download(signal(), ignore), (error: unknown) => error instanceof ApiError && !`${error.message}${JSON.stringify(error)}`.includes(sensitive) && error.cause === undefined);
  await clean(files);
});

test("saved Hugging Face tokens take precedence over the environment without masking vault errors", async t => {
  const previous = process.env.HF_TOKEN;
  process.env.HF_TOKEN = "environment-test-token";
  t.after(() => { if (previous === undefined) delete process.env.HF_TOKEN; else process.env.HF_TOKEN = previous; });
  for (const token of [undefined, "saved-test-token"]) {
    const { files } = await fixture(t, { huggingFaceToken: () => token, fetch: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token ?? "environment-test-token"}`);
      return response();
    } });
    await files.download(signal(), ignore);
  }
  const { files } = await fixture(t, { huggingFaceToken: () => { throw new ApiError(503, "CREDENTIALS_UNREADABLE", "Saved integration credentials could not be unlocked."); }, fetch: async () => assert.fail("Do not silently fall back when the credential vault is unreadable") });
  await assert.rejects(files.download(signal(), ignore), { code: "CREDENTIALS_UNREADABLE" });
  await clean(files);
});
