import { randomUUID } from "node:crypto";
import { createConnection, isIP, type Socket } from "node:net";
import nodemailer, { type SendMailOptions, type SMTPTransportOptions } from "nodemailer";
import { ApiError } from "../../packages/contracts/index.ts";
import type { MailConfiguration, MailProviderId, MailSendResult, MailSettingsView } from "../../packages/contracts/mail.ts";
import type { CredentialVault } from "./credentials.ts";
import type { Store } from "./store.ts";

const metadataKey = "mail-settings";
const providers = ["smtp", "resend", "cloudflare"] as const;
const credentialIds = { smtp: "mail-smtp", resend: "mail-resend", cloudflare: "mail-cloudflare" } as const;
const maxResponseBytes = 64 * 1024;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const changed = () => new ApiError(409, "MAIL_SETTINGS_CHANGED", "Mail settings changed. Reload them and try again.");
const timedOut = () => new ApiError(504, "MAIL_TIMEOUT", "The mail provider took too long to respond. Delivery may already have started.");
const invalidResponse = () => new ApiError(502, "MAIL_INVALID_RESPONSE", "The mail provider returned an invalid response.");
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new ApiError(400, "INVALID_MAIL_SETTINGS", message); }
function providerId(value: unknown): MailProviderId { check(providers.includes(value as MailProviderId), "Choose SMTP, Resend or Cloudflare."); return value as MailProviderId; }
function revision(value: unknown): asserts value is number { check(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER, "Reload the current mail settings before saving."); }
function cancelled(signal: AbortSignal): ApiError { return signal.reason instanceof ApiError ? signal.reason : new ApiError(499, "MAIL_CANCELLED", "The mail request was cancelled. Delivery may already have started."); }

/** A single mailbox, never a display name, address list or SMTP command. */
export function mailAddress(value: unknown): string {
  check(typeof value === "string" && value.length <= 254 && /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value), "Enter a single email address without a display name.");
  const [local, domain] = value.split("@");
  check(local.length <= 64 && domain.split(".").every(label => label.length >= 1 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-")), "Enter a valid email address.");
  return `${local}@${domain.toLowerCase()}`;
}
function configuration(value: unknown): MailConfiguration | null {
  if (value === null) return null;
  check(object(value) && Object.keys(value).every(key => ["provider", "fromEmail", "fromName", "smtp"].includes(key)), "Supply the mail provider and sender settings.");
  const provider = providerId(value.provider), fromEmail = mailAddress(value.fromEmail);
  check(value.fromName === undefined || typeof value.fromName === "string" && value.fromName.length <= 100 && !/[\x00-\x1f\x7f]/.test(value.fromName), "The sender name must contain at most 100 characters and no control characters.");
  const fromName = typeof value.fromName === "string" ? value.fromName.trim() : "";
  if (provider !== "smtp") { check(value.smtp === undefined, "Only custom SMTP accepts server settings."); return { provider, fromEmail, ...(fromName ? { fromName } : {}) }; }
  const smtp = value.smtp;
  check(object(smtp) && Object.keys(smtp).every(key => ["host", "port", "security", "username"].includes(key)), "Supply the SMTP host, port, TLS mode and username.");
  check(typeof smtp.host === "string" && smtp.host.length <= 253 && (isIP(smtp.host) !== 0 || smtp.host.split(".").every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))), "Enter an SMTP hostname or IP address without a URL or credentials.");
  check(typeof smtp.port === "number" && Number.isInteger(smtp.port) && smtp.port >= 1 && smtp.port <= 65535, "Enter an SMTP port between 1 and 65535.");
  check(smtp.security === "tls" || smtp.security === "starttls", "Choose implicit TLS or required STARTTLS.");
  check(typeof smtp.username === "string" && smtp.username.length >= 1 && smtp.username.length <= 320 && !/[\x00-\x1f\x7f]/.test(smtp.username), "Enter an SMTP username without control characters.");
  return { provider, fromEmail, ...(fromName ? { fromName } : {}), smtp: { host: smtp.host.toLowerCase(), port: smtp.port, security: smtp.security, username: smtp.username } };
}
function encodedSecret(provider: MailProviderId, value: string): string {
  if (provider === "smtp") {
    check(Buffer.byteLength(value, "utf8") >= 1 && Buffer.byteLength(value, "utf8") <= 2048 && !/[\x00-\x1f\x7f]/.test(value), "Enter an SMTP password of at most 2048 bytes without control characters.");
    return `smtp-v1:${Buffer.from(value, "utf8").toString("base64url")}`;
  }
  check(/^[\x21-\x7e]{8,4096}$/.test(value), "Enter an API token containing 8–4096 characters without spaces.");
  return value;
}
function smtpSecret(value: string): string {
  if (!value.startsWith("smtp-v1:")) throw new ApiError(503, "MAIL_SECRET_UNREADABLE", "The saved SMTP password could not be read. Save it again.");
  const decoded = Buffer.from(value.slice(8), "base64url").toString("utf8");
  if (encodedSecret("smtp", decoded) !== value) throw new ApiError(503, "MAIL_SECRET_UNREADABLE", "The saved SMTP password could not be read. Save it again.");
  return decoded;
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
interface SavedSettings { version: 1; revision: number; configuration: MailConfiguration | null }
interface Message { to: string; subject: string; text: string; html: string; idempotencyKey: string }
export interface MailSmtpTransport {
  sendMail(message: SendMailOptions): Promise<{ accepted: readonly string[]; rejected: readonly string[] }>;
  close(): void;
}
export interface MailServiceOptions {
  fetch?: typeof fetch;
  smtpFactory?: (options: SMTPTransportOptions) => MailSmtpTransport;
  timeoutMs?: number;
}

/** Admin-configured destinations only. Sending is an explicit caller action. */
export class MailService {
  private store: Store;
  private credentials: CredentialVault;
  private fetcher: typeof fetch;
  private smtpFactory: NonNullable<MailServiceOptions["smtpFactory"]>;
  private timeoutMs: number;
  private closed = false;
  private operations = new Map<AbortController, Promise<unknown>>();
  constructor(store: Store, credentials: CredentialVault, options: MailServiceOptions = {}) {
    this.store = store; this.credentials = credentials; this.fetcher = options.fetch ?? fetch;
    this.smtpFactory = options.smtpFactory ?? (options => nodemailer.createTransport(options));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) throw new TypeError("Mail timeout must be between 1 and 60000 milliseconds.");
  }
  private requireOpen() { if (this.closed) throw new ApiError(503, "MAIL_STOPPING", "The studio is restarting. Try again shortly."); }
  private saved(): SavedSettings {
    const value = this.store.metadata<SavedSettings>(metadataKey);
    if (!value) return { version: 1, revision: 0, configuration: null };
    try {
      check(value.version === 1, "Unknown mail settings version."); revision(value.revision);
      return { version: 1, revision: value.revision, configuration: configuration(value.configuration) };
    } catch { throw new ApiError(503, "MAIL_SETTINGS_UNREADABLE", "Saved mail settings could not be read."); }
  }
  view(): MailSettingsView {
    const saved = this.saved();
    const status = (provider: MailProviderId) => { const stored = this.credentials.status(credentialIds[provider]); return stored ? { configured: true, updatedAt: stored.updatedAt } : { configured: false }; };
    return { revision: saved.revision, configuration: saved.configuration, credentials: { smtp: status("smtp"), resend: status("resend"), cloudflare: status("cloudflare") } };
  }
  private expectRevision(expected: unknown): SavedSettings {
    revision(expected);
    const current = this.saved();
    if (current.revision !== expected) throw changed();
    return current;
  }
  private invalidate() { for (const controller of this.operations.keys()) controller.abort(changed()); }
  save(body: unknown): MailSettingsView {
    this.requireOpen();
    check(object(body) && Object.keys(body).every(key => ["revision", "configuration", "secret"].includes(key)), "Supply the current revision, mail configuration and optional replacement secret.");
    const next = configuration(body.configuration);
    check(body.secret === undefined || body.secret === null || typeof body.secret === "string", "Supply a replacement secret or null to remove it.");
    check(next !== null || body.secret === undefined, "Choose a mail provider before changing its secret.");
    const replacement = typeof body.secret === "string" ? encodedSecret(next!.provider, body.secret) : undefined;
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.expectRevision(body.revision);
      if (next) {
        const id = credentialIds[next.provider];
        if (replacement !== undefined) this.credentials.set(id, replacement);
        else if (body.secret === null || next.provider === "smtp" && JSON.stringify(current.configuration?.smtp) !== JSON.stringify(next.smtp)) this.credentials.delete(id);
      }
      this.store.setMetadata(metadataKey, { version: 1, revision: current.revision + 1, configuration: next });
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    this.invalidate();
    return this.view();
  }
  removeSecret(provider: unknown, expectedRevision: unknown): MailSettingsView {
    this.requireOpen();
    const id = providerId(provider);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.expectRevision(expectedRevision);
      this.credentials.delete(credentialIds[id]);
      this.store.setMetadata(metadataKey, { ...current, revision: current.revision + 1 });
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    this.invalidate();
    return this.view();
  }
  sendInvitation(input: { to: string; inviteId: string; token: string; expiresAt: string }, trustedBaseUrl: string, signal?: AbortSignal): Promise<MailSendResult> {
    const to = mailAddress(input.to);
    check(typeof input.inviteId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(input.inviteId) && typeof input.token === "string" && /^[A-Za-z0-9_-]{20,512}$/.test(input.token), "Supply a valid invitation.");
    check(typeof input.expiresAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.expiresAt) && Number.isFinite(Date.parse(input.expiresAt)), "Supply the invitation expiration time.");
    let origin: URL;
    try { origin = new URL(trustedBaseUrl); } catch { throw new ApiError(503, "MAIL_ORIGIN_REQUIRED", "Configure the studio's public origin before emailing invitations."); }
    if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new ApiError(503, "MAIL_ORIGIN_REQUIRED", "Configure the studio's public origin before emailing invitations.");
    const url = `${origin.origin}/invite#token=${input.token}`;
    return this.send({ to, subject: "Your Gravity Studio invitation", text: `You have been invited to Gravity Studio.\n\nCreate your account: ${url}\n\nThis invitation expires at ${input.expiresAt}.\nIf you did not expect this invitation, you can ignore this email.`, html: `<p>You have been invited to Gravity Studio.</p><p><a href="${escapeHtml(url)}">Create your account</a></p><p>This invitation expires at ${escapeHtml(input.expiresAt)}.</p><p>If you did not expect this invitation, you can ignore this email.</p>`, idempotencyKey: `gravity-invite-${input.inviteId}` }, signal);
  }
  sendTest(body: unknown, signal?: AbortSignal): Promise<MailSendResult> {
    check(object(body) && Object.keys(body).every(key => key === "to"), "Supply the recipient of this test email.");
    const to = mailAddress(body.to);
    return this.send({ to, subject: "Gravity Studio email test", text: "This test email was requested by a Gravity Studio administrator.", html: "<p>This test email was requested by a Gravity Studio administrator.</p>", idempotencyKey: `gravity-test-${randomUUID()}` }, signal);
  }
  private operation<T>(work: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    this.requireOpen();
    const controller = new AbortController(), signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(timedOut()), this.timeoutMs);
    let onAbort: () => void;
    const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(cancelled(signal)); signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort(); });
    const flight = Promise.race([aborted, Promise.resolve().then(() => { if (signal.aborted) throw cancelled(signal); return work(signal); })]).finally(() => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); this.operations.delete(controller); });
    this.operations.set(controller, flight);
    return flight;
  }
  private send(message: Message, external?: AbortSignal): Promise<MailSendResult> {
    this.requireOpen();
    const config = this.saved().configuration;
    if (!config) throw new ApiError(409, "MAIL_NOT_CONFIGURED", "Configure invitation email in Administration first.");
    const stored = this.credentials.get(credentialIds[config.provider]);
    if (!stored) throw new ApiError(409, "MAIL_SECRET_REQUIRED", "Save the mail provider credential before sending email.");
    const secret = config.provider === "smtp" ? smtpSecret(stored) : stored;
    return this.operation(async signal => {
      try { return config.provider === "resend" ? await this.sendResend(config, secret, message, signal) : await this.sendSmtp(config, secret, message, signal); }
      catch (error) {
        if (signal.aborted) throw cancelled(signal);
        if (error instanceof ApiError) throw error;
        const code = (error as { code?: unknown })?.code;
        if (code === "ETIMEDOUT") throw timedOut();
        if (code === "EAUTH") throw new ApiError(502, "MAIL_AUTH_FAILED", "The mail provider rejected the saved credential.");
        if (code === "EENVELOPE") throw new ApiError(502, "MAIL_RECIPIENT_REJECTED", "The mail provider rejected the sender or recipient address.");
        throw new ApiError(502, "MAIL_SEND_FAILED", "The mail provider could not accept the message. Check the sender, credentials and connection settings.");
      }
    }, external);
  }
  private async sendResend(config: MailConfiguration, secret: string, message: Message, signal: AbortSignal): Promise<MailSendResult> {
    const from = config.fromName ? `${JSON.stringify(config.fromName)} <${config.fromEmail}>` : config.fromEmail;
    const response = await this.fetcher("https://api.resend.com/emails", { method: "POST", redirect: "manual", signal, headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", "Idempotency-Key": message.idempotencyKey }, body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text, html: message.html }) });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) throw new ApiError(502, "MAIL_AUTH_FAILED", "Resend rejected the credential or sender. Check the API key and verified sending domain.");
      if (response.status === 429) throw new ApiError(429, "MAIL_RATE_LIMITED", "The mail provider rate limit was reached. Try again later.");
      throw new ApiError(502, "MAIL_SEND_FAILED", "Resend could not accept the message. Check the sender and provider configuration.");
    }
    if (!response.body || Number(response.headers.get("content-length")) > maxResponseBytes) { void response.body?.cancel().catch(() => {}); throw invalidResponse(); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw cancelled(signal);
      for (;;) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw cancelled(signal);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxResponseBytes) throw invalidResponse();
        chunks.push(value);
      }
      let result: unknown;
      try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw invalidResponse(); }
      if (!object(result) || typeof result.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.id) || result.id.includes(secret)) throw invalidResponse();
      return { provider: "resend", messageId: result.id };
    } finally { signal.removeEventListener("abort", abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  private async sendSmtp(config: MailConfiguration, secret: string, message: Message, signal: AbortSignal): Promise<MailSendResult> {
    const smtp = config.provider === "cloudflare" ? { host: "smtp.mx.cloudflare.net", port: 465, security: "tls", username: "api_token" } : config.smtp!;
    let socket: Socket | undefined, transport: MailSmtpTransport | undefined, cancelConnect: (() => void) | undefined;
    const stop = () => { socket?.destroy(); cancelConnect?.(); transport?.close(); };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const options: SMTPTransportOptions = {
        host: smtp.host, port: smtp.port, secure: smtp.security === "tls", requireTLS: true,
        tls: { rejectUnauthorized: true, minVersion: "TLSv1.2", ...(isIP(smtp.host) ? {} : { servername: smtp.host }) },
        auth: { user: smtp.username, pass: secret }, forceAuth: true,
        connectionTimeout: this.timeoutMs, greetingTimeout: this.timeoutMs, socketTimeout: this.timeoutMs, dnsTimeout: this.timeoutMs,
        maxResponseSize: maxResponseBytes, maxRecipients: 1, disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false,
        // Retain the underlying socket: closing a non-pooled Nodemailer transport alone
        // does not interrupt an active SMTP exchange, including a STARTTLS wrapper.
        getSocket: (_options, callback) => {
          if (signal.aborted) { callback(cancelled(signal)); return; }
          socket = createConnection({ host: smtp.host, port: smtp.port });
          let settled = false;
          const onError = (error: Error) => { if (settled) return; settled = true; cancelConnect = undefined; callback(error); };
          cancelConnect = () => onError(cancelled(signal));
          socket.once("error", onError);
          socket.once("connect", () => { if (settled) return; settled = true; cancelConnect = undefined; socket!.removeListener("error", onError); if (signal.aborted) { socket!.destroy(); callback(cancelled(signal)); } else callback(null, { connection: socket! }); });
        },
      };
      transport = this.smtpFactory(options);
      if (signal.aborted) throw cancelled(signal);
      const messageId = `<${randomUUID()}@${config.fromEmail.split("@")[1]}>`;
      const info = await transport.sendMail({ from: { name: config.fromName ?? "", address: config.fromEmail }, to: { address: message.to, name: "" }, envelope: { from: config.fromEmail, to: [message.to] }, subject: message.subject, text: message.text, html: message.html, messageId, disableFileAccess: true, disableUrlAccess: true });
      if (signal.aborted) throw cancelled(signal);
      if (!info.accepted?.some(address => address.toLowerCase() === message.to.toLowerCase()) || info.rejected?.length) throw new ApiError(502, "MAIL_RECIPIENT_REJECTED", "The mail provider did not accept the recipient address.");
      return { provider: config.provider, messageId };
    } finally { signal.removeEventListener("abort", stop); stop(); }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.operations.keys()) controller.abort(new ApiError(503, "MAIL_STOPPING", "The studio is restarting. Delivery may already have started."));
    await Promise.allSettled(this.operations.values());
  }
}
