import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CredentialVault } from "../../apps/server/credentials.ts";
import { MailService, mailAddress, type MailServiceOptions } from "../../apps/server/mail.ts";
import { Store } from "../../apps/server/store.ts";
import type { MailConfiguration } from "../../packages/contracts/mail.ts";

const secret = "fixture-mail-key-12345678";
const resend: MailConfiguration = { provider: "resend", fromEmail: "invitations@example.com", fromName: 'Studio "Example"' };
const smtp: MailConfiguration = { provider: "smtp", fromEmail: "invitations@example.com", smtp: { host: "smtp.example.com", port: 587, security: "starttls", username: "studio" } };
const invite = { to: "recipient@example.com", inviteId: "test-invitation-id", token: "fixture-invitation-token-1234567890", expiresAt: "2099-10-10T12:00:00.000Z" };
const accepted = () => Response.json({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
const unreachable = async (): Promise<Response> => { throw new Error("Unexpected outbound request in mail test"); };
async function fixture(t: TestContext, options: MailServiceOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gravity-mail-")), store = new Store(directory);
  const master = randomBytes(32).toString("base64"), vault = new CredentialVault(store, { key: master });
  const service = new MailService(store, vault, { fetch: unreachable, ...options });
  t.after(async () => { await service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const save = (configuration: MailConfiguration | null = resend, ...replacement: [secret?: string | null]) => {
    const value = replacement.length ? replacement[0] : secret;
    return service.save({ revision: service.view().revision, configuration, ...(value !== undefined ? { secret: value } : {}) });
  };
  return { service, store, vault, directory, master, save };
}
async function smtpServer(t: TestContext, connected: (socket: Socket) => void) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); connected(socket); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return (server.address() as AddressInfo).port;
}

test("mail settings expose only safe metadata and persist encrypted secrets separately from image settings", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.service.view(), { revision: 0, configuration: null, credentials: { smtp: { configured: false }, resend: { configured: false }, cloudflare: { configured: false } } });
  const imageSettings = f.store.settings();
  const saved = f.save();
  assert.equal(saved.revision, 1); assert.equal(saved.credentials.resend.configured, true);
  assert.equal(JSON.stringify(saved).includes(secret), false); assert.equal(JSON.stringify(saved).includes("suffix"), false);
  assert.deepEqual(f.store.settings(), imageSettings);
  assert.equal(f.vault.get("mail-resend"), secret); assert.equal(f.vault.get("mail-smtp"), undefined);
  assert.equal(JSON.stringify(f.store.metadata("mail-settings")).includes(secret), false);
  assert.equal((await readFile(join(f.directory, "studio.sqlite"))).includes(Buffer.from(secret)), false);
  const reopened = new Store(f.directory), restored = new MailService(reopened, new CredentialVault(reopened, { key: f.master }));
  try { assert.deepEqual(restored.view(), saved); } finally { await restored.close(); reopened.close(); }
});

test("mail setting writes and credential removal use optimistic revisions and roll back together", async t => {
  const f = await fixture(t); const before = f.save();
  assert.throws(() => f.service.save({ revision: 0, configuration: resend, secret: "replacement-key" }), { code: "MAIL_SETTINGS_CHANGED" });
  assert.throws(() => f.service.removeSecret("resend", 0), { code: "MAIL_SETTINGS_CHANGED" });
  assert.throws(() => f.service.save({ revision: 1, configuration: resend, secret: "short" }), { code: "INVALID_MAIL_SETTINGS" });
  assert.deepEqual(f.service.view(), before); assert.equal(f.vault.get("mail-resend"), secret);
  const setMetadata = f.store.setMetadata.bind(f.store);
  f.store.setMetadata = () => { throw new Error("simulated metadata write failure"); };
  assert.throws(() => f.service.save({ revision: 1, configuration: resend, secret: "replacement-key" }), /simulated metadata/);
  f.store.setMetadata = setMetadata;
  assert.deepEqual(f.service.view(), before); assert.equal(f.vault.get("mail-resend"), secret);
  assert.equal(f.service.removeSecret("resend", 1).credentials.resend.configured, false);
  assert.equal(f.service.view().revision, 2);
});

test("SMTP passwords retain spaces and Unicode, while destination and account changes discard the old password", async t => {
  let sentPassword = "";
  const f = await fixture(t, { smtpFactory: options => { sentPassword = options.auth!.pass!; return { close() {}, async sendMail() { return { accepted: [invite.to], rejected: [] }; } }; } });
  const password = "  żółć password  "; f.save(smtp, password);
  assert.notEqual(f.vault.get("mail-smtp"), password);
  await f.service.sendTest({ to: invite.to }); assert.equal(sentPassword, password);
  f.save({ ...smtp, fromName: "Different name", smtp: { ...smtp.smtp!, host: "SMTP.EXAMPLE.COM" } }, undefined);
  assert.equal(f.service.view().credentials.smtp.configured, true, "equivalent normalized host and changed display name retain the password");
  for (const patch of [{ host: "other.example.com" }, { port: 465 }, { security: "tls" as const }, { username: "other-user" }]) {
    f.save(smtp, password); f.save({ ...smtp, smtp: { ...smtp.smtp!, ...patch } }, undefined);
    assert.equal(f.service.view().credentials.smtp.configured, false);
  }
  f.save({ ...smtp, smtp: { ...smtp.smtp!, host: "third.example.com" } }, "replacement password");
  assert.equal(f.service.view().credentials.smtp.configured, true);
  f.save(resend); assert.equal(f.service.view().credentials.smtp.configured, true, "separate provider secrets are independent");
  f.save(smtp, undefined); assert.equal(f.service.view().credentials.smtp.configured, false, "a previous SMTP password cannot move to a newly selected destination");
});

test("mail configuration rejects header injection, arbitrary API URLs and malformed SMTP destinations", async t => {
  const f = await fixture(t);
  for (const address of ["Alice <alice@example.com>", "a@example.com,b@example.com", "a@example.com\r\nBcc: stolen@example.com", "a@-example.com", "a@example..com", "a..b@example.com", " a@example.com", "a@example.com "]) assert.throws(() => mailAddress(address), { code: "INVALID_MAIL_SETTINGS" });
  assert.equal(mailAddress("user+invites@EXAMPLE.COM"), "user+invites@example.com");
  for (const configuration of [
    { ...resend, fromName: "Name\r\nBcc: stolen@example.com" }, { ...resend, baseUrl: "https://evil.example" },
    { ...resend, smtp: smtp.smtp }, { ...smtp, smtp: { ...smtp.smtp, host: "smtp://user:pass@smtp.example" } },
    { ...smtp, smtp: { ...smtp.smtp, host: "smtp.example/other" } }, { ...smtp, smtp: { ...smtp.smtp, port: 0 } },
    { ...smtp, smtp: { ...smtp.smtp, security: "none" } }, { ...smtp, smtp: { ...smtp.smtp, tls: { rejectUnauthorized: false } } },
    { ...smtp, smtp: { ...smtp.smtp, username: "user\nAUTH PLAIN" } },
  ]) assert.throws(() => f.service.save({ revision: 0, configuration, secret }), { code: "INVALID_MAIL_SETTINGS" });
  assert.throws(() => f.save(smtp, "pass\r\nword"), { code: "INVALID_MAIL_SETTINGS" });
  assert.throws(() => f.service.save({ revision: 0, configuration: null, secret }), { code: "INVALID_MAIL_SETTINGS" });
  assert.equal(f.service.view().revision, 0);
});

test("disabled or incomplete mail settings cannot send and saving configuration never sends", async t => {
  let calls = 0; const f = await fixture(t, { fetch: async () => { calls++; return accepted(); } });
  assert.throws(() => f.service.sendTest({ to: invite.to }), { code: "MAIL_NOT_CONFIGURED" });
  f.save(resend, undefined);
  assert.throws(() => f.service.sendTest({ to: invite.to }), { code: "MAIL_SECRET_REQUIRED" });
  f.save(); assert.equal(calls, 0);
  f.save(null, undefined); assert.equal(f.service.view().configuration, null);
  assert.throws(() => f.service.sendTest({ to: invite.to }), { code: "MAIL_NOT_CONFIGURED" });
  assert.equal(calls, 0);
});

test("Resend sends a bounded invitation through its fixed endpoint with an admin sender and a fragment token", async t => {
  let calls = 0;
  const f = await fixture(t, { fetch: async (url, init) => {
    calls++; assert.equal(url, "https://api.resend.com/emails"); assert.equal(init!.method, "POST"); assert.equal(init!.redirect, "manual");
    assert.equal(new Headers(init!.headers).get("authorization"), `Bearer ${secret}`);
    assert.equal(new Headers(init!.headers).get("idempotency-key"), `gravity-invite-${invite.inviteId}`);
    const body = JSON.parse(String(init!.body));
    assert.equal(body.from, '"Studio \\"Example\\"" <invitations@example.com>');
    assert.deepEqual(body.to, [invite.to]); assert.equal(body.subject, "Your Gravity Studio invitation");
    assert.ok(body.text.includes(`https://studio.example/invite#token=${invite.token}`));
    assert.ok(body.html.includes(`href="https://studio.example/invite#token=${invite.token}"`));
    assert.equal(body.text.includes(secret), false); assert.equal(body.html.includes(secret), false);
    assert.deepEqual(Object.keys(body).sort(), ["from", "html", "subject", "text", "to"]);
    return accepted();
  } });
  f.save();
  assert.deepEqual(await f.service.sendInvitation(invite, "https://studio.example"), { provider: "resend", messageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
  assert.equal(calls, 1);
});

test("invitation callers cannot inject headers, arbitrary links or an API sender", async t => {
  let calls = 0; const f = await fixture(t, { fetch: async () => { calls++; return accepted(); } }); f.save();
  for (const origin of ["https://user:pass@studio.example", "https://studio.example/path", "https://studio.example?token=other", "https://studio.example#evil", "file:///tmp/invite", "not a url"]) assert.throws(() => f.service.sendInvitation(invite, origin), { code: "MAIL_ORIGIN_REQUIRED" });
  for (const input of [{ ...invite, to: "a@example.com,b@example.com" }, { ...invite, token: "https://evil.example/invite" }, { ...invite, token: `${invite.token}\" onclick=evil` }, { ...invite, inviteId: "id\r\nheader" }, { ...invite, expiresAt: "<img src=x>" }]) assert.throws(() => f.service.sendInvitation(input, "https://studio.example"), { code: "INVALID_MAIL_SETTINGS" });
  assert.throws(() => f.service.sendTest({ to: invite.to, from: "attacker@example.com" }), { code: "INVALID_MAIL_SETTINGS" });
  assert.equal(calls, 0);
});

test("Resend never follows redirects, never retries and keeps upstream error bodies out of API errors", async t => {
  for (const [status, code] of [[302, "MAIL_SEND_FAILED"], [401, "MAIL_AUTH_FAILED"], [403, "MAIL_AUTH_FAILED"], [429, "MAIL_RATE_LIMITED"], [500, "MAIL_SEND_FAILED"]] as const) {
    let calls = 0, cancelled = false;
    const f = await fixture(t, { fetch: async (_url, init) => { calls++; assert.equal(init!.redirect, "manual"); return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(secret)); }, cancel() { cancelled = true; } }), { status, headers: { location: `https://other.example/${secret}` } }); } });
    f.save();
    await assert.rejects(f.service.sendTest({ to: invite.to }), error => { assert.equal((error as { code: string }).code, code); assert.equal(String(error).includes(secret), false); return true; });
    assert.equal(calls, 1); assert.equal(cancelled, true);
  }
});

test("Resend bounds response bodies, validates message IDs and cancels oversized streams", async t => {
  let cancelled = false;
  const responses = [
    () => new Response("{}"), () => new Response("not json"), () => Response.json({ id: secret }),
    () => new Response("small", { headers: { "content-length": "65537" } }),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; } })),
  ];
  for (const response of responses) {
    const f = await fixture(t, { fetch: async () => response() }); f.save();
    await assert.rejects(f.service.sendTest({ to: invite.to }), { code: "MAIL_INVALID_RESPONSE" });
  }
  assert.equal(cancelled, true);
});

test("SMTP and Cloudflare use verified TLS, fixed Cloudflare credentials, bounded replies and no external file loading", async t => {
  for (const config of [smtp, { provider: "cloudflare", fromEmail: "invitations@example.com" } as MailConfiguration]) {
    let closed = 0;
    const f = await fixture(t, { smtpFactory: options => {
      assert.equal(options.host, config.provider === "cloudflare" ? "smtp.mx.cloudflare.net" : "smtp.example.com");
      assert.equal(options.port, config.provider === "cloudflare" ? 465 : 587);
      assert.equal(options.secure, config.provider === "cloudflare"); assert.equal(options.requireTLS, true); assert.equal(options.forceAuth, true);
      assert.equal(options.tls!.rejectUnauthorized, true); assert.equal(options.tls!.minVersion, "TLSv1.2");
      assert.equal(options.auth!.user, config.provider === "cloudflare" ? "api_token" : "studio"); assert.equal(options.auth!.pass, secret);
      assert.equal(options.maxResponseSize, 65536); assert.equal(options.disableFileAccess, true); assert.equal(options.disableUrlAccess, true);
      return { close() { closed++; }, async sendMail(message) {
        assert.deepEqual(message.envelope, { from: config.fromEmail, to: [invite.to] }); assert.deepEqual(message.to, { address: invite.to, name: "" });
        assert.equal(message.disableFileAccess, true); assert.equal(message.disableUrlAccess, true); assert.equal(message.attachments, undefined);
        return { accepted: [invite.to], rejected: [] };
      } };
    } });
    f.save(config);
    const sent = await f.service.sendTest({ to: invite.to });
    assert.equal(sent.provider, config.provider); assert.match(sent.messageId!, /^<[0-9a-f-]+@example\.com>$/); assert.equal(closed, 1);
  }
});

test("SMTP rejection and auth errors are sanitized and always close the transport", async t => {
  for (const [result, code] of [[{ accepted: [], rejected: [invite.to] }, "MAIL_RECIPIENT_REJECTED"], [Object.assign(new Error(secret), { code: "EAUTH" }), "MAIL_AUTH_FAILED"], [new Error(secret), "MAIL_SEND_FAILED"]] as const) {
    let closed = false;
    const f = await fixture(t, { smtpFactory: () => ({ close() { closed = true; }, async sendMail() { if (result instanceof Error) throw result; return result; } }) }); f.save(smtp);
    await assert.rejects(f.service.sendTest({ to: invite.to }), error => { assert.equal((error as { code: string }).code, code); assert.equal(String(error).includes(secret), false); return true; });
    assert.equal(closed, true);
  }
});

test("mail deadlines cover stalled fetches and response bodies, while shutdown and settings changes abort pending requests", async t => {
  const stalled = async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => { init!.signal!.addEventListener("abort", () => reject(new Error(secret)), { once: true }); });
  const timeout = await fixture(t, { fetch: stalled, timeoutMs: 20 }); timeout.save();
  await assert.rejects(timeout.service.sendTest({ to: invite.to }), { code: "MAIL_TIMEOUT" });
  let bodyCancelled = false;
  const streaming = await fixture(t, { fetch: async () => new Response(new ReadableStream({ cancel() { bodyCancelled = true; } })), timeoutMs: 20 }); streaming.save();
  await assert.rejects(streaming.service.sendTest({ to: invite.to }), { code: "MAIL_TIMEOUT" }); assert.equal(bodyCancelled, true);
  for (const change of ["close", "save", "remove"] as const) {
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    const f = await fixture(t, { fetch: async (url, init) => { started(); return stalled(url, init); } }); f.save();
    const flight = f.service.sendTest({ to: invite.to }); const rejected = assert.rejects(flight, { code: change === "close" ? "MAIL_STOPPING" : "MAIL_SETTINGS_CHANGED" });
    await ready;
    if (change === "close") await f.service.close(); else if (change === "save") f.save(resend, "changed-mail-key"); else f.service.removeSecret("resend", f.service.view().revision);
    await rejected;
  }
});

test("pre-aborted calls do not open a connection and SMTP cancellation closes an active transport", async t => {
  let calls = 0, closed = false, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, { smtpFactory: () => { calls++; return { close() { closed = true; }, async sendMail() { started(); return new Promise(() => {}); } }; } }); f.save(smtp);
  await assert.rejects(f.service.sendTest({ to: invite.to }, AbortSignal.abort()), { code: "MAIL_CANCELLED" }); assert.equal(calls, 0);
  const controller = new AbortController(); const flight = f.service.sendTest({ to: invite.to }, controller.signal);
  const rejected = assert.rejects(flight, { code: "MAIL_CANCELLED" }); await ready; controller.abort(new Error(secret)); await rejected;
  assert.equal(closed, true); await f.service.close();
  assert.throws(() => f.service.sendTest({ to: invite.to }), { code: "MAIL_STOPPING" });
});

test("real SMTP protocol cannot downgrade to plaintext when STARTTLS is unavailable", async t => {
  let commands = "";
  const port = await smtpServer(t, socket => {
    socket.write("220 localhost fixture SMTP\r\n");
    socket.on("data", bytes => {
      const line = bytes.toString(); commands += line;
      if (line.startsWith("EHLO")) socket.write("250-localhost\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (line.startsWith("STARTTLS")) socket.write("502 STARTTLS unavailable\r\n");
      else socket.write("500 Unexpected command\r\n");
    });
  });
  const f = await fixture(t, { timeoutMs: 1000 }); f.save({ ...smtp, smtp: { ...smtp.smtp!, host: "127.0.0.1", port } });
  await assert.rejects(f.service.sendTest({ to: invite.to }), { code: "MAIL_SEND_FAILED" });
  assert.match(commands, /EHLO/); assert.match(commands, /STARTTLS/);
  assert.equal(commands.includes("AUTH"), false); assert.equal(commands.includes("MAIL FROM"), false); assert.equal(commands.includes(secret), false);
});

test("a deadline destroys the actual SMTP socket even when the server stalls before its greeting", async t => {
  let closed!: () => void; const connectionClosed = new Promise<void>(resolve => { closed = resolve; });
  let connected = false;
  const port = await smtpServer(t, socket => { connected = true; socket.on("close", closed); });
  const f = await fixture(t, { timeoutMs: 100 }); f.save({ ...smtp, smtp: { ...smtp.smtp!, host: "127.0.0.1", port } });
  await assert.rejects(f.service.sendTest({ to: invite.to }), { code: "MAIL_TIMEOUT" });
  assert.equal(connected, true);
  await Promise.race([connectionClosed, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("SMTP socket remained open after timeout")), 1000); timer.unref(); })]);
});
