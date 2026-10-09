import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { Store } from "../../apps/server/store.ts";
import { createSession, digest, hashPassword, identify, LoginLimiter, setupKey, validSetupKey, validateCredentials, verifyPassword } from "../../apps/server/auth.ts";

test("passwords use salted derivation and wrong credentials fail", async () => {
  const password = "long enough password";
  const one = await hashPassword(password);
  const two = await hashPassword(password);
  assert.notEqual(one, two);
  assert.equal(await verifyPassword(password, one), true);
  assert.equal(await verifyPassword("wrong", one), false);
  assert.equal(await verifyPassword(password), false);
  assert.throws(() => validateCredentials({ username: "owner", password: "short" }), /12 and 256/);
  assert.equal(validateCredentials({ username: "Owner", password }).username, "owner");
});

test("setup key persists privately and sessions are hashed, revocable credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gravity-auth-"));
  const store = new Store(directory);
  try {
    const key = await setupKey(directory);
    assert.equal(key, await setupKey(directory));
    assert.equal(statSync(join(directory, "setup.key")).mode & 0o777, 0o600);
    assert.equal(validSetupKey(key, key), true);
    assert.equal(validSetupKey("other", key), false);
    const owner = store.createOwner("owner", "hash");
    const cookie = createSession(store, owner, true);
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    assert.match(cookie, /Secure/);
    const request = { headers: { cookie: cookie.split(";")[0] } } as IncomingMessage;
    const identity = identify(request, store);
    assert.equal(identity?.source, "session");
    assert.deepEqual({ ...identity?.user }, owner);
    const token = cookie.split(";")[0].split("=")[1];
    assert.equal(store.session(token), undefined);
    store.revokeSession(digest(token));
    assert.equal(identify(request, store), undefined);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("login throttling bounds password work and can reset after successful login", () => {
  const limiter = new LoginLimiter();
  for (let i = 0; i < 10; i++) limiter.check("client");
  assert.throws(() => limiter.check("client"), /Too many/);
  limiter.reset("client");
  assert.doesNotThrow(() => limiter.check("client"));
});
