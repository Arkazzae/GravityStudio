import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Store } from "../../apps/server/store.ts";
import { Engine } from "../../apps/server/engine.ts";
import { Administration } from "../../apps/server/administration.ts";
import { WorkTimeService } from "../../apps/server/work-time.ts";
import { createSession, digest } from "../../apps/server/auth.ts";
import { createStudioServer } from "../../apps/server/http.ts";
import { saveInput, saveOutput } from "../../apps/server/media.ts";
import { inventory } from "./helpers/engine-fixture.ts";
import { FakeObjectStore } from "./helpers/fake-object-store.ts";
import { PNG } from "../inference/fake-comfy.ts";

const origin = "https://studio.example.test";
const invitationInput = { role: "user", expiresInHours: 24, initialTimeMs: 3_600_000, sendEmail: false };
async function fixture(t: { after(fn: () => Promise<void>): void }, objects?: FakeObjectStore) {
  const directory = await mkdtemp(join(tmpdir(), "gravity-admin-"));
  const store = new Store(directory, { objectStore: objects });
  const owner = store.createOwner("owner", "unused");
  const time = new WorkTimeService(store), admin = new Administration(store, time);
  const beforeClose: Array<() => Promise<void>> = [];
  t.after(async () => { for (const close of beforeClose) await close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  async function invite(username = "member", extra = {}) {
    const created = admin.createInvitation(owner.id, { ...invitationInput, ...extra });
    const user = await admin.acceptInvitation({ token: created.token, username, password: "A strong fixture password" });
    return { user, created };
  }
  return { directory, store, owner, time, admin, invite, beforeClose };
}

test("legacy owner migration preserves credentials, sessions and administrator role across restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gravity-legacy-admin-"));
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE,password TEXT,created_at TEXT); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE sessions(hash TEXT PRIMARY KEY,user_id TEXT,expires_at INTEGER);");
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run("old-owner", "legacy", "password-hash", "2020-01-01T00:00:00.000Z");
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run("session-hash", "old-owner", Date.now() + 60_000); db.close();
  let store = new Store(directory);
  try {
    assert.deepEqual({ ...store.owner() }, { id: "old-owner", username: "legacy", role: "admin" });
    assert.equal(store.passwordUser("legacy")?.password, "password-hash");
    assert.equal(store.session("session-hash")?.role, "admin");
    store.close(); store = new Store(directory);
    assert.equal(store.owner()?.role, "admin");
    assert.equal(new WorkTimeService(store).view("old-owner").balance.usedMs, 0);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("invitations store only token hashes, expire, revoke and atomically consume once with initial credit", async t => {
  const f = await fixture(t);
  const created = f.admin.createInvitation(f.owner.id, { ...invitationInput, email: "member@example.test" });
  const row = f.store.db.prepare("SELECT * FROM invitations WHERE id=?").get(created.invitation.id)!;
  assert.equal(row.token_hash, digest(created.token));
  assert.equal(JSON.stringify(row).includes(created.token), false);
  assert.equal(JSON.stringify(f.admin.invitations()).includes("token"), false);
  const attempts = await Promise.allSettled(["member-one", "member-two"].map(username => f.admin.acceptInvitation({ token: created.token, username, password: "A strong fixture password" })));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  const user = attempts.find(result => result.status === "fulfilled")!.value;
  assert.equal(f.time.view(user.id).balance.grantedMs, 3_600_000);
  assert.equal(f.time.view(user.id).adjustments.length, 1);
  assert.throws(() => f.admin.inspectInvitation(created.token), { code: "INVITATION_UNAVAILABLE" });
  const expired = f.admin.createInvitation(f.owner.id, invitationInput);
  f.store.db.prepare("UPDATE invitations SET expires_at=? WHERE id=?").run(new Date(0).toISOString(), expired.invitation.id);
  assert.throws(() => f.admin.inspectInvitation(expired.token), { code: "INVITATION_UNAVAILABLE" });
  const revoked = f.admin.createInvitation(f.owner.id, invitationInput);
  f.admin.revokeInvitation(f.owner.id, revoked.invitation.id);
  await assert.rejects(f.admin.acceptInvitation({ token: revoked.token, username: "revoked", password: "A strong fixture password" }), { code: "INVITATION_UNAVAILABLE" });
  const collision = f.admin.createInvitation(f.owner.id, invitationInput);
  await assert.rejects(f.admin.acceptInvitation({ token: collision.token, username: user.username, password: "A strong fixture password" }), { code: "USERNAME_TAKEN" });
  assert.equal(f.admin.inspectInvitation(collision.token).role, "user");
});

test("role changes and suspension revoke sessions, API tokens and outstanding invitations with stale-write protection", async t => {
  const f = await fixture(t), { user } = await f.invite("administrator", { role: "admin" });
  const session = createSession(f.store, user, true).split(";")[0].split("=")[1];
  f.store.saveApiToken(user.id, "client", digest("api-token"));
  const invite = f.admin.createInvitation(user.id, invitationInput);
  assert.throws(() => f.admin.update(f.owner.id, f.owner.id, { revision: 0, role: "user", status: "active" }), { code: "OWN_ACCOUNT_PROTECTED" });
  const updated = f.admin.update(f.owner.id, user.id, { revision: 0, role: "user", status: "active" });
  assert.equal(updated.revision, 1);
  assert.equal(f.store.session(digest(session)), undefined);
  assert.equal(f.store.apiToken(digest("api-token")), undefined);
  assert.throws(() => f.admin.inspectInvitation(invite.token), { code: "INVITATION_UNAVAILABLE" });
  assert.throws(() => f.admin.update(f.owner.id, user.id, { revision: 0, role: "admin", status: "active" }), { code: "USER_CHANGED" });
  f.admin.update(f.owner.id, user.id, { revision: 1, role: "user", status: "suspended" });
  assert.equal(f.store.passwordUser(user.username), undefined);
  assert.throws(() => createSession(f.store, user, true), { code: "ACCOUNT_INACTIVE" });
  assert.throws(() => f.admin.createInvitation(user.id, invitationInput), { code: "ACCOUNT_INACTIVE" });
});

test("account deletion blocks active reservations, cancels queued work and erases media while retaining anonymous usage", async t => {
  const objects = new FakeObjectStore(), f = await fixture(t, objects), { user } = await f.invite();
  await f.invite(`deleted-${user.id}`);
  const otherInput = await saveInput(f.store, f.owner.id, Buffer.from(PNG), "owner.png");
  const input = await saveInput(f.store, user.id, Buffer.from(PNG), "member.png");
  const job = f.store.createJob(user.id, { modelId: "sdxl-base", prompt: "Private image" }, {}, [], "SDXL", {}, randomUUID(), "image");
  f.store.patchJob(job.id, { status: "preparing" });
  await assert.rejects(f.admin.deleteUser(f.owner.id, user.id, { revision: 0, confirmation: user.username }), { code: "USER_HAS_ACTIVE_TASKS" });
  const output = await saveOutput(f.store, job.id, 0, PNG);
  f.store.patchJob(job.id, { status: "succeeded", outputs: [output] });
  f.store.createJob(user.id, { modelId: "sdxl-base", prompt: "Queued" }, {}, [], "SDXL", {}, randomUUID(), "queued");
  await f.admin.deleteUser(f.owner.id, user.id, { revision: 0, confirmation: user.username });
  assert.equal(f.store.jobs(user.id).length, 0); assert.equal(f.store.inputs(user.id).length, 0);
  assert.equal(objects.objects.size, 1); assert.equal(f.store.input(otherInput.id, f.owner.id).id, otherInput.id);
  assert.throws(() => f.store.input(input.id, user.id), { code: "INPUT_NOT_FOUND" });
  assert.throws(() => f.admin.user(user.id), { code: "USER_NOT_FOUND" });
  const tombstone = f.store.db.prepare("SELECT username,email,password,status FROM users WHERE id=?").get(user.id)!;
  assert.equal(tombstone.status, "deleted"); assert.equal(tombstone.email, null); assert.equal(tombstone.password, "");
  assert.notEqual(tombstone.username, user.username); assert.equal(f.time.view(user.id).sessions.length, 1);
  assert.equal(f.time.view(user.id).adjustments.length, 1);
});

test("failed bucket cleanup durably disables an account and recovery finishes without losing other users' media", async t => {
  const objects = new FakeObjectStore(), f = await fixture(t, objects), { user } = await f.invite();
  await saveInput(f.store, user.id, Buffer.from(PNG), "private.png");
  objects.failDelete = true;
  await assert.rejects(f.admin.deleteUser(f.owner.id, user.id, { revision: 0, confirmation: user.username }), { status: 503 });
  assert.equal(f.admin.user(user.id).status, "deleting");
  await assert.rejects(saveInput(f.store, user.id, Buffer.from(PNG), "racing-upload.png"), { code: "ACCOUNT_INACTIVE" });
  assert.equal(objects.objects.size, 1);
  objects.failDelete = false;
  await f.admin.recoverDeletions();
  assert.equal(objects.objects.size, 0);
  assert.equal(f.admin.users().length, 1);
  await f.admin.recoverDeletions();
});

test("account deletion waits for an in-flight upload and invitation grants roll back with failed account creation", async t => {
  const objects = new FakeObjectStore(), f = await fixture(t, objects), { user } = await f.invite();
  let finishPut!: () => void, startedPut!: () => void;
  const started = new Promise<void>(resolve => { startedPut = resolve; });
  objects.beforePut = () => { startedPut(); return new Promise<void>(resolve => { finishPut = resolve; }); };
  const upload = saveInput(f.store, user.id, Buffer.from(PNG), "in-flight.png");
  await started;
  await assert.rejects(f.admin.deleteUser(f.owner.id, user.id, { revision: 0, confirmation: user.username }), { code: "USER_UPLOAD_IN_PROGRESS" });
  assert.equal(f.admin.user(user.id).status, "active");
  finishPut(); await upload;
  await f.admin.deleteUser(f.owner.id, user.id, { revision: 0, confirmation: user.username });
  assert.equal(objects.objects.size, 0);
  const created = f.admin.createInvitation(f.owner.id, invitationInput);
  f.store.db.exec("CREATE TRIGGER fail_invite_grant BEFORE INSERT ON work_time_adjustments BEGIN SELECT RAISE(ABORT,'fixture'); END;");
  await assert.rejects(f.admin.acceptInvitation({ token: created.token, username: "rolled-back", password: "A strong fixture password" }));
  assert.equal(f.store.passwordUser("rolled-back"), undefined);
  assert.equal(f.admin.inspectInvitation(created.token).initialTimeMs, 3_600_000);
});

test("suspension preserves metadata for already-admitted uploads so subsequent deletion can erase their objects", async t => {
  const objects = new FakeObjectStore(), f = await fixture(t, objects), { user } = await f.invite();
  objects.beforePut = async () => { f.admin.update(f.owner.id, user.id, { revision: 0, role: "user", status: "suspended" }); objects.failDelete = true; };
  await saveInput(f.store, user.id, Buffer.from(PNG), "suspended-upload.png");
  assert.equal(f.store.inputs(user.id).length, 1); assert.equal(objects.objects.size, 1);
  await assert.rejects(saveInput(f.store, user.id, Buffer.from(PNG), "another.png"), { code: "ACCOUNT_INACTIVE" });
  await assert.rejects(f.admin.deleteUser(f.owner.id, user.id, { revision: 1, confirmation: user.username }), { status: 503 });
  objects.failDelete = false; await f.admin.recoverDeletions();
  assert.equal(objects.objects.size, 0);
});

test("HTTP protects all global administration from users and bearer tokens while keeping private Studio operations", async t => {
  const f = await fixture(t), { user } = await f.invite();
  const engine = new Engine(f.store, { detect: async () => inventory() });
  let sends = 0;
  const server = await createStudioServer({ store: f.store, engine, allowedOrigins: [origin], setupSecret: "fixture", mail: {
    view: () => ({ revision: 0, configuration: null, credentials: { smtp: { configured: false }, resend: { configured: false }, cloudflare: { configured: false } } }),
    save: () => { throw new Error("Unexpected save"); }, removeSecret: () => { throw new Error("Unexpected removal"); },
    sendInvitation: async () => { sends++; throw new Error("private SMTP password failure"); },
    sendTest: async () => { sends++; return { provider: "smtp", messageId: "test" }; }, close: async () => {},
  } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  f.beforeClose.push(async () => { await server.closeOperations(); await engine.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ownerCookie = createSession(f.store, f.owner, true).split(";")[0], memberCookie = createSession(f.store, user, true).split(";")[0];
  async function request(path: string, method = "GET", body?: unknown, cookie = memberCookie, extra = {}) {
    return fetch(base + "/api" + path, { method, headers: { Origin: origin, Cookie: cookie, ...extra, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  for (const path of ["/admin/users", "/admin/invitations", "/admin/work-time", "/admin/mail", "/integrations", "/settings", "/runtime", "/models/library", "/hardware", "/text/models"]) assert.equal((await request(path)).status, 403, path);
  for (const path of ["/models/download", "/models/access", "/models/activate", "/runtime", "/workers/probe", "/workers/any/unload", "/text/local", "/text/local/unload", "/admin/mail/test", "/admin/invitations"]) assert.equal((await request(path, "POST", {})).status, 403, path);
  for (const path of ["/settings", "/integrations/gemini", "/text/assistant", "/text/connection", "/text/local", "/admin/mail"]) assert.equal((await request(path, "PUT", {})).status, 403, path);
  assert.equal(sends, 0);
  for (const path of ["/account", "/jobs", "/inputs", "/favorites", "/catalog", "/upscalers", "/tokens", "/work-time", "/text/settings", "/text/local"]) assert.equal((await request(path)).status, 200, path);
  const settings = await (await request("/text/settings")).json(); assert.equal("connection" in settings, false);
  const state = await (await request("/state")).json(); assert.equal(state.hardware.gpus[0].pciAddress, null);
  const userToken = await (await request("/tokens", "POST", { name: "Client" })).json();
  assert.equal((await request("/jobs", "GET", undefined, "", { Authorization: `Bearer ${userToken.token}` })).status, 200);
  f.store.saveApiToken(f.owner.id, "Admin client", digest("admin-api-token"));
  assert.equal((await request("/admin/users", "GET", undefined, "", { Authorization: "Bearer admin-api-token" })).status, 403);
  const invitationResponse = await request("/admin/invitations", "POST", { ...invitationInput, email: "new@example.test", sendEmail: true }, ownerCookie);
  assert.equal(invitationResponse.status, 201);
  const created = await invitationResponse.json(); assert.equal(created.invitation.delivery, "failed"); assert.equal(sends, 1);
  assert.equal(JSON.stringify(created).includes("private SMTP"), false); assert.match(created.url, /^https:\/\/studio\.example\.test\/invite#token=/);
  const token = new URLSearchParams(new URL(created.url).hash.slice(1)).get("token");
  assert.equal((await request("/invitations/inspect", "POST", { token }, "")).status, 200);
  const accepted = await request("/invitations/accept", "POST", { token, username: "new-member", password: "A strong fixture password" }, "");
  assert.equal(accepted.status, 201); assert.match(accepted.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
  assert.equal((await accepted.json()).user.role, "user");
  assert.equal((await request("/invitations/accept", "POST", { token, username: "duplicate", password: "A strong fixture password" }, "")).status, 404);
  assert.equal((await fetch(base + "/api/invitations/accept", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await request(`/admin/users/${user.id}`, "PATCH", { revision: 0, role: "user", status: "suspended" }, ownerCookie)).status, 200);
  assert.equal((await request("/jobs")).status, 401);
  assert.equal((await request("/jobs", "GET", undefined, "", { Authorization: `Bearer ${userToken.token}` })).status, 401);
});
