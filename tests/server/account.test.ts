import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { AVATAR_THEME_IDS, type AccountProfile } from "../../packages/contracts/account.ts";
import { accountView, saveAccount } from "../../apps/server/account.ts";
import { Store } from "../../apps/server/store.ts";
import { Engine } from "../../apps/server/engine.ts";
import { createSession, digest } from "../../apps/server/auth.ts";
import { createStudioServer } from "../../apps/server/http.ts";

const origin = "http://localhost:4321";
const initial: AccountProfile = { revision: 0, displayName: "owner", workspaceName: "Personal workspace", avatarTheme: "studio" };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "gravity-account-"));
  const store = new Store(directory);
  const owner = store.createOwner("owner", "fixture-password-hash");
  const cookie = createSession(store, owner, false).split(";")[0];
  const engine = new Engine(store);
  const server = await createStudioServer({ store, engine, allowedOrigins: [origin], setupSecret: "fixture-setup" });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await server.closeOperations(); await engine.stop(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(`${url}/api/account`, {
    method,
    headers: { Origin: origin, Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { store, owner, cookie, url, request };
}

test("account preferences require a browser session and allowed mutation origin", async t => {
  const api = await fixture(t);
  for (const method of ["GET", "PUT"]) {
    const response = await fetch(`${api.url}/api/account`, { method, headers: { Origin: origin, ...(method === "PUT" ? { "Content-Type": "application/json" } : {}) }, ...(method === "PUT" ? { body: JSON.stringify(initial) } : {}) });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "UNAUTHENTICATED");
  }
  const token = "fixture-account-api-token";
  api.store.saveApiToken(api.owner.id, "Fixture client", digest(token));
  for (const method of ["GET", "PUT"]) {
    const response = await api.request(method, method === "PUT" ? initial : undefined, { Authorization: `Bearer ${token}` });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "SESSION_REQUIRED", "a valid session cookie cannot bypass bearer-token refusal");
  }
  const missingOrigin = await fetch(`${api.url}/api/account`, { method: "PUT", headers: { Cookie: api.cookie, "Content-Type": "application/json" }, body: JSON.stringify(initial) });
  assert.equal(missingOrigin.status, 403);
  assert.equal((await missingOrigin.json()).error.code, "ORIGIN_REQUIRED");
  for (const method of ["GET", "PUT"]) {
    const response = await api.request(method, method === "PUT" ? initial : undefined, { Origin: "https://attacker.example" });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "ORIGIN_NOT_ALLOWED");
  }
  const allowedRead = await fetch(`${api.url}/api/account`, { headers: { Cookie: api.cookie } });
  assert.equal(allowedRead.status, 200, "an owner session can read without a mutation origin");
  assert.equal(api.store.metadata(`account:${api.owner.id}`), undefined);
});

test("account defaults and trimmed saves leave authentication and Studio settings unchanged", async t => {
  const api = await fixture(t);
  const response = await api.request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), initial);
  assert.equal(api.store.metadata(`account:${api.owner.id}`), undefined, "reading defaults does not write preferences");
  const settings = api.store.settings();
  const owner = api.store.passwordUser("owner");
  const saved: AccountProfile = { revision: 1, displayName: "Arkązz Studio", workspaceName: "My images", avatarTheme: "mint" };
  const updated = await api.request("PUT", { ...saved, revision: 0, displayName: "  Arkązz Studio  ", workspaceName: "  My images  " });
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), saved);
  assert.deepEqual(await (await api.request()).json(), saved);
  assert.deepEqual(api.store.metadata(`account:${api.owner.id}`), saved);
  assert.deepEqual(api.store.settings(), settings);
  assert.deepEqual(api.store.passwordUser("owner"), owner);
  const bootstrap = await (await fetch(`${api.url}/api/bootstrap`, { headers: { Cookie: api.cookie } })).json();
  assert.deepEqual(bootstrap.user, api.owner);
  assert.equal("displayName" in bootstrap.user, false);
  let revision = saved.revision;
  for (const avatarTheme of AVATAR_THEME_IDS) {
    const result = await api.request("PUT", { ...saved, revision, avatarTheme });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { ...saved, revision: ++revision, avatarTheme });
  }
});

test("invalid account fields are rejected without modifying persisted preferences or echoing input", async t => {
  const api = await fixture(t);
  const saved = await (await api.request("PUT", initial)).json() as AccountProfile;
  const invalid: unknown[] = [
    {}, { revision: 1 }, { ...saved, email: "fixture-private-email@example.test" }, { ...saved, password: "fixture-private-password" },
    { ...saved, revision: -1 }, { ...saved, revision: 1.5 }, { ...saved, revision: "1" }, { ...saved, revision: null },
    { ...saved, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...saved, avatarTheme: "unknown-private-theme" }, { ...saved, avatarTheme: null },
  ];
  for (const field of ["displayName", "workspaceName"]) {
    for (const value of [null, 12, "", "   ", "x".repeat(65), "name\nwith newline", "\tname", "name\u0000", "name\u007f", "name\u0085"]) invalid.push({ ...saved, [field]: value });
  }
  for (const body of invalid) {
    const response = await api.request("PUT", body);
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.equal(JSON.parse(text).error.code, "INVALID_ACCOUNT");
    assert.equal(text.includes("fixture-private"), false);
    assert.equal(text.includes("unknown-private-theme"), false);
    assert.deepEqual(api.store.metadata(`account:${api.owner.id}`), saved);
  }
  for (const body of [null, [], "account"]) assert.equal((await api.request("PUT", body)).status, 400);
  const badJson = await fetch(`${api.url}/api/account`, { method: "PUT", headers: { Origin: origin, Cookie: api.cookie, "Content-Type": "application/json" }, body: "not-json-fixture-private" });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.text()).includes("not-json-fixture-private"), false);
  assert.equal((await api.request("PUT", saved, { "Content-Type": "text/plain" })).status, 415);
  const longest = { ...saved, displayName: "x".repeat(64), workspaceName: "ą".repeat(64) };
  assert.equal((await api.request("PUT", longest)).status, 200);
});

test("concurrent account updates use an atomic revision check and stale saves preserve the winner", async t => {
  const api = await fixture(t);
  const results = await Promise.all([
    api.request("PUT", { ...initial, displayName: "First window", avatarTheme: "blue" }),
    api.request("PUT", { ...initial, displayName: "Second window", avatarTheme: "rose" }),
  ]);
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  const winner = await results.find(response => response.status === 200)!.json() as AccountProfile;
  const conflict = await results.find(response => response.status === 409)!.json();
  assert.equal(conflict.error.code, "ACCOUNT_CHANGED");
  assert.equal(winner.revision, 1);
  assert.deepEqual(await (await api.request()).json(), winner);
  const stale = await api.request("PUT", { ...initial, displayName: "Stale profile", workspaceName: "Stale workspace", avatarTheme: "violet" });
  assert.equal(stale.status, 409);
  assert.deepEqual(api.store.metadata(`account:${api.owner.id}`), winner);
  const next = await api.request("PUT", { ...winner, workspaceName: "Next workspace" });
  assert.equal(next.status, 200, "conflicts release the transaction for later saves");
  assert.deepEqual(await next.json(), { ...winner, revision: 2, workspaceName: "Next workspace" });
});

test("account metadata survives restart and remains scoped to each owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gravity-account-restart-"));
  let store = new Store(directory);
  try {
    const owner = store.createOwner("owner", "fixture-password-hash");
    const anotherOwner = { id: "another-owner", username: "another" };
    const saved = saveAccount(store, owner, { ...initial, displayName: "Persistent profile", avatarTheme: "lime" });
    assert.deepEqual(accountView(store, anotherOwner), { ...initial, displayName: "another" });
    const otherSaved = saveAccount(store, anotherOwner, { ...initial, displayName: "Other profile", avatarTheme: "violet" });
    store.close(); store = new Store(directory);
    assert.deepEqual(accountView(store, owner), saved);
    assert.deepEqual(accountView(store, anotherOwner), otherSaved);
    assert.deepEqual({ ...store.owner() }, owner);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("account storage errors are sanitized and failed writes roll back cleanly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gravity-account-failure-"));
  const store = new Store(directory);
  try {
    const owner = store.createOwner("owner", "fixture-password-hash");
    store.db.exec("CREATE TRIGGER reject_account BEFORE INSERT ON metadata WHEN NEW.key LIKE 'account:%' BEGIN SELECT RAISE(ABORT,'fixture-private-storage-error'); END;");
    assert.throws(() => saveAccount(store, owner, initial), error => {
      assert.equal((error as { code: string }).code, "ACCOUNT_UNAVAILABLE");
      assert.equal(String(error).includes("fixture-private-storage-error"), false);
      return true;
    });
    assert.equal(store.metadata(`account:${owner.id}`), undefined);
    store.db.exec("DROP TRIGGER reject_account");
    const saved = saveAccount(store, owner, initial);
    assert.equal(saved.revision, 1);
    store.setMetadata(`account:${owner.id}`, { ...saved, password: "fixture-private-invalid-metadata" });
    assert.throws(() => accountView(store, owner), { code: "ACCOUNT_UNAVAILABLE" });
    assert.throws(() => saveAccount(store, owner, saved), { code: "ACCOUNT_UNAVAILABLE" });
    assert.deepEqual(store.metadata(`account:${owner.id}`), { ...saved, password: "fixture-private-invalid-metadata" });
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
