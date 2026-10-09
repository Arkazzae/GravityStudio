import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Store } from "../../apps/server/store.ts";
import { CredentialVault } from "../../apps/server/credentials.ts";

const secret = "fixture-provider-key-1234";
const masterKey = () => randomBytes(32).toString("base64");
function fixture(run: (store: Store, directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "gravity-credentials-"));
  const store = new Store(directory);
  const configured = process.env.GRAVITY_CREDENTIALS_KEY;
  delete process.env.GRAVITY_CREDENTIALS_KEY;
  try { run(store, directory); }
  finally {
    if (configured !== undefined) process.env.GRAVITY_CREDENTIALS_KEY = configured;
    else delete process.env.GRAVITY_CREDENTIALS_KEY;
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("credentials are encrypted at rest, expose only a suffix and reopen with the private key", () => fixture((store, directory) => {
  const vault = new CredentialVault(store);
  assert.equal(vault.get("openai"), undefined);
  assert.equal(vault.status("openai"), null);
  assert.equal(existsSync(join(directory, "credentials.key")), false, "empty vault reads do not create a key");
  const saved = vault.set("openai", ` \n${secret}\t `);
  assert.deepEqual(Object.keys(saved).sort(), ["suffix", "updatedAt"]);
  assert.equal(saved.suffix, "1234");
  assert.equal(vault.get("openai"), secret);
  assert.deepEqual(vault.status("openai"), saved);
  assert.equal(statSync(join(directory, "credentials.key")).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(directory, "credentials.key")).length, 32);
  assert.equal(JSON.stringify(store.settings()).includes(secret), false);
  for (const name of readdirSync(directory)) assert.equal(readFileSync(join(directory, name)).includes(Buffer.from(secret)), false, `no plaintext credential in ${name}`);
  const reopened = new Store(directory);
  try {
    const restored = new CredentialVault(reopened);
    assert.equal(restored.get("openai"), secret);
    assert.deepEqual(restored.status("openai"), saved);
    restored.delete("openai");
    restored.delete("openai");
    assert.equal(restored.status("openai"), null);
    assert.equal(restored.get("openai"), undefined);
  } finally { reopened.close(); }
}));

test("saving the same key uses a fresh nonce and ciphertext every time", () => fixture(store => {
  const vault = new CredentialVault(store, { key: masterKey() });
  vault.set("huggingface", secret);
  const first = store.db.prepare("SELECT ciphertext,iv,tag FROM integration_credentials").get();
  vault.set("huggingface", secret);
  const second = store.db.prepare("SELECT ciphertext,iv,tag FROM integration_credentials").get();
  assert.notDeepEqual(second?.iv, first?.iv);
  assert.notDeepEqual(second?.ciphertext, first?.ciphertext);
  assert.notDeepEqual(second?.tag, first?.tag);
  assert.equal(vault.get("huggingface"), secret);
}));

test("a configured master key is used without creating a local key file", () => fixture((store, directory) => {
  const key = masterKey();
  process.env.GRAVITY_CREDENTIALS_KEY = key;
  new CredentialVault(store).set("gemini", secret);
  assert.equal(existsSync(join(directory, "credentials.key")), false);
  assert.equal(new CredentialVault(store, { key }).get("gemini"), secret);
}));

test("API key validation and unsupported providers fail without reflecting input", () => fixture(store => {
  const vault = new CredentialVault(store, { key: masterKey() });
  for (const value of [null, 123, {}, "short", "contains secret space", "secret\nnewline", "secret\ttab", "unicode-secret-💀", "x".repeat(4097)]) {
    assert.throws(() => vault.set("civitai", value), { code: "INVALID_API_KEY" });
  }
  assert.throws(() => vault.set("unknown" as "civitai", secret), { code: "INVALID_INTEGRATION" });
  assert.equal(vault.status("civitai"), null);
  assert.equal(vault.set("civitai", "x".repeat(4096)).suffix, "xxxx");
}));

test("invalid configured keys load lazily and never fall back to another key", () => fixture((store, directory) => {
  for (const key of ["", "not-base64", Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64"), `${masterKey()}\n`]) {
    const vault = new CredentialVault(store, { key });
    assert.equal(vault.status("anthropic"), null);
    assert.equal(vault.get("anthropic"), undefined);
    assert.throws(() => vault.set("anthropic", secret), { code: "CREDENTIALS_KEY_UNAVAILABLE" });
    assert.equal(existsSync(join(directory, "credentials.key")), false);
  }
  assert.equal(store.settings().revision, 0, "other store operations remain available");
}));

test("a missing private key is not regenerated while encrypted credentials exist", () => fixture((store, directory) => {
  const vault = new CredentialVault(store);
  const saved = vault.set("nanogpt", secret);
  const path = join(directory, "credentials.key");
  const key = readFileSync(path);
  rmSync(path);
  const reopened = new CredentialVault(store);
  assert.deepEqual(reopened.status("nanogpt"), saved);
  assert.throws(() => reopened.get("nanogpt"), { code: "CREDENTIALS_KEY_UNAVAILABLE" });
  assert.throws(() => reopened.set("openai", "another-provider-key"), { code: "CREDENTIALS_KEY_UNAVAILABLE" });
  assert.equal(existsSync(path), false);
  writeFileSync(path, key, { mode: 0o600 });
  assert.equal(new CredentialVault(store).get("nanogpt"), secret);
}));

test("unsafe private key paths and permissions fail closed", () => fixture((store, directory) => {
  const path = join(directory, "credentials.key");
  writeFileSync(path, randomBytes(32), { mode: 0o600 });
  chmodSync(path, 0o644);
  assert.throws(() => new CredentialVault(store).set("openai", secret), { code: "CREDENTIALS_KEY_UNAVAILABLE" });
  rmSync(path);
  mkdirSync(path);
  assert.throws(() => new CredentialVault(store).set("openai", secret), { code: "CREDENTIALS_KEY_UNAVAILABLE" });
  rmSync(path, { recursive: true });
  const target = join(directory, "unrelated.key");
  const original = randomBytes(32);
  writeFileSync(target, original, { mode: 0o600 });
  symlinkSync(target, path);
  assert.throws(() => new CredentialVault(store).set("openai", secret), { code: "CREDENTIALS_KEY_UNAVAILABLE" });
  assert.deepEqual(readFileSync(target), original);
  rmSync(path);
  writeFileSync(path, randomBytes(31), { mode: 0o600 });
  assert.throws(() => new CredentialVault(store).set("openai", secret), { code: "CREDENTIALS_KEY_UNAVAILABLE" });
}));

test("wrong keys and tampered ciphertext cannot overwrite saved credentials", () => fixture(store => {
  const key = masterKey();
  const vault = new CredentialVault(store, { key });
  vault.set("openai", secret);
  const before = store.db.prepare("SELECT * FROM integration_credentials").get();
  const wrong = new CredentialVault(store, { key: masterKey() });
  assert.throws(() => wrong.get("openai"), { code: "CREDENTIALS_UNREADABLE" });
  assert.throws(() => wrong.set("openai", "replacement-key-5678"), { code: "CREDENTIALS_UNREADABLE" });
  assert.throws(() => wrong.set("gemini", "new-provider-key-5678"), { code: "CREDENTIALS_UNREADABLE" });
  assert.deepEqual(store.db.prepare("SELECT * FROM integration_credentials").get(), before);
  assert.equal(vault.get("openai"), secret);
  store.db.prepare("UPDATE integration_credentials SET ciphertext=? WHERE provider=?").run(Buffer.alloc(secret.length), "openai");
  assert.throws(() => vault.get("openai"), { code: "CREDENTIALS_UNREADABLE" });
  assert.throws(() => vault.set("openai", "replacement-key-5678"), { code: "CREDENTIALS_UNREADABLE" });
  assert.equal((store.db.prepare("SELECT count(*) AS count FROM integration_credentials").get() as { count: number }).count, 1);
}));

test("authentication binds encrypted credentials to their provider and public metadata", () => fixture(store => {
  const key = masterKey();
  const vault = new CredentialVault(store, { key });
  vault.set("openai", secret);
  store.db.prepare("UPDATE integration_credentials SET provider=? WHERE provider=?").run("anthropic", "openai");
  assert.throws(() => vault.get("anthropic"), { code: "CREDENTIALS_UNREADABLE" });
  store.db.prepare("UPDATE integration_credentials SET provider=?,suffix=? WHERE provider=?").run("openai", "5678", "anthropic");
  assert.throws(() => vault.get("openai"), { code: "CREDENTIALS_UNREADABLE" });
  store.db.prepare("UPDATE integration_credentials SET suffix=?,updated_at=? WHERE provider=?").run("1234", "2000-01-01T00:00:00.000Z", "openai");
  assert.throws(() => vault.get("openai"), { code: "CREDENTIALS_UNREADABLE" });
}));

test("simultaneous server processes share one first-run private key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gravity-credentials-race-"));
  const store = new Store(directory);
  new CredentialVault(store);
  const env = { ...process.env };
  delete env.GRAVITY_CREDENTIALS_KEY;
  const script = `
    import { Store } from ${JSON.stringify(new URL("../../apps/server/store.ts", import.meta.url).href)};
    import { CredentialVault } from ${JSON.stringify(new URL("../../apps/server/credentials.ts", import.meta.url).href)};
    const store = new Store(process.argv[1]);
    const vault = new CredentialVault(store);
    process.stdout.write("ready\\n");
    process.stdin.once("data", () => {
      try { vault.set(process.argv[2], "fixture-racing-key-1234"); store.close(); process.exit(0); }
      catch { store.close(); process.exit(1); }
    });
  `;
  const children = ["openai", "gemini"].map(provider => spawn(process.execPath, ["--input-type=module", "-e", script, directory, provider], { env, stdio: ["pipe", "pipe", "pipe"] }));
  try {
    const exited = children.map(child => new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    }));
    await Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`Fixture server exited before ready (${code}).`)));
    })));
    for (const child of children) child.stdin.end("save\n");
    assert.deepEqual(await Promise.all(exited), [0, 0]);
    const key = readFileSync(join(directory, "credentials.key")).toString("base64");
    const vault = new CredentialVault(store, { key });
    assert.equal(vault.get("openai"), "fixture-racing-key-1234");
    assert.equal(vault.get("gemini"), "fixture-racing-key-1234");
  } finally {
    for (const child of children) child.kill();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
