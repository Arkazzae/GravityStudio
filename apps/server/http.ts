import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from 'node:stream';
import { ApiError, type StudioSettings } from "../../packages/contracts/index.ts";
import { InferenceError } from "../../packages/inference/index.ts";
import { Engine } from "./engine.ts";
import { Store, publicJob } from "./store.ts";
import { cookieToken, createSession, clearSession, digest, hashPassword, identify, LoginLimiter, setupKey, validSetupKey, validateCredentials, verifyPassword } from "./auth.ts";
import { deleteInput, deleteOutput, inputBytes, outputBytes, MAX_INPUT_BYTES, recoverMediaDeletions, saveInput, saveInputFromOutput } from "./media.ts";
import { settingsView, validateSettings } from "./settings.ts";
import { mcpResponse, MCP_INLINE_INPUT_BYTES } from "./mcp.ts";
import { RuntimeSetup, type ManagedWorkerBinding } from "./runtime.ts";
import { ModelLibrary } from "./models.ts";
import { modelRegistry } from "./registry.ts";
import { CredentialVault } from "./credentials.ts";
import { INTEGRATION_PROVIDERS, integrationProvider, testIntegration } from "./integrations.ts";
import { TextService } from "./text.ts";
import { LocalTextRuntime } from "./local-text.ts";
import { accountView, saveAccount } from "./account.ts";
import { Administration, requireActiveUser, requireAdministrator } from "./administration.ts";
import { WorkTimeService, requireWorkTime } from "./work-time.ts";
import { MailService } from "./mail.ts";
import { StorageUsageService } from "./storage-usage.ts";
import { API_SCOPES, type ApiScope } from '../../packages/contracts/access.ts';
import { httpScopes, tokenOptions } from './access.ts';
import { ApiMedia, hash } from './api-media.ts';
import { imageBody, ImageRequestError, OPENAI_IMAGE_BODY_LIMIT, openaiImages } from './openai-images.ts';
import { openaiChat, parseChatRequest } from './openai-text.ts';

const safeHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
function json(response: ServerResponse, data: unknown, status = 200) {
  response.writeHead(status, { ...safeHeaders, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}
async function readBytes(request: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(request.headers["content-length"]) > limit) throw new ApiError(413, "REQUEST_TOO_LARGE", "The request is too large.");
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new ApiError(413, "REQUEST_TOO_LARGE", "The request is too large.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function readJson(request: IncomingMessage, limit = 128 * 1024): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new ApiError(415, "INVALID_CONTENT_TYPE", "Use application/json for this request.");
  const bytes = await readBytes(request, limit);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new ApiError(400, "INVALID_JSON", "The request must contain valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "INVALID_JSON", "The request must contain an object.");
  return value as Record<string, unknown>;
}
function protectManagedWorkers(current: StudioSettings, next: StudioSettings, managedWorkers: ManagedWorkerBinding[]) {
  for (const managed of managedWorkers) {
    const registered = current.workers.filter(worker => worker.id === managed.id || worker.baseUrl === managed.baseUrl);
    const proposed = next.workers.filter(worker => worker.id === managed.id || worker.baseUrl === managed.baseUrl);
    if (!registered.length && !proposed.length) continue;
    const previous = registered[0], worker = proposed[0];
    if (registered.length !== 1 || proposed.length !== 1 || !previous || !worker || worker.id !== previous.id || worker.baseUrl !== managed.baseUrl || worker.location !== "local" || worker.deviceIds.length !== 1 || worker.deviceIds[0] !== managed.deviceId || worker.enabled !== previous.enabled) {
      throw new ApiError(409, "MANAGED_WORKER_LOCKED", "Managed GPU connections cannot be changed or removed here. Use Settings → GPUs to choose which GPUs to use.");
    }
  }
}
export interface ServerOptions {
  store: Store;
  engine: Engine;
  allowedOrigins: string[];
  setupSecret?: string;
  runtime?: Pick<RuntimeSetup, "status" | "start" | "close" | "managedWorkers">;
  models?: Pick<ModelLibrary, "view" | "checkAccess" | "start" | "activate" | "busy" | "close">;
  integrationFetch?: typeof fetch;
  textFetch?: typeof fetch;
  mail?: Pick<MailService, "view" | "save" | "removeSecret" | "sendInvitation" | "sendTest" | "close">;
  localText?: Pick<LocalTextRuntime, 'initialize' | 'status' | 'prepare' | 'configure' | 'release' | 'models' | 'run' | 'evictIdle' | 'close'>;
}
export async function createStudioServer(options: ServerOptions) {
  const { store, engine } = options;
  await recoverMediaDeletions(store, { remote: false });
  const credentials = new CredentialVault(store);
  const workTime = new WorkTimeService(store);
  const administration = new Administration(store, workTime);
  const mail = options.mail ?? new MailService(store, credentials);
  const storageUsage = new StorageUsageService(store);
  const localText = options.localText ?? new LocalTextRuntime(store, engine, { huggingFaceToken: () => credentials.get('huggingface') });
  await localText.initialize();
  const text = new TextService(store, credentials, { fetch: options.textFetch, local: localText });
  const apiMedia = new ApiMedia(store);
  const runtime = options.runtime ?? new RuntimeSetup(store, engine);
  const models = options.models ?? new ModelLibrary(store, engine, { huggingFaceToken: () => credentials.get("huggingface") });
  const bootstrapSecret = options.setupSecret ?? await setupKey(store.directory);
  const limiter = new LoginLimiter();
  const origins = new Set(options.allowedOrigins.map(origin => new URL(origin).origin));
  const invitationOrigin = options.allowedOrigins[0] ? new URL(options.allowedOrigins[0]).origin : undefined;
  const integrationChecks = new Map<string, Promise<unknown>>();
  const mediaOperations = new Set<Promise<unknown>>();
  const mediaOperation = async <T,>(run: () => Promise<T>): Promise<T> => {
    if (stopping) throw new ApiError(503, "STUDIO_STOPPING", "The studio is restarting. Try again shortly.");
    const operation = run(); mediaOperations.add(operation);
    try { return await operation; } finally { mediaOperations.delete(operation); }
  };
  let stopping = false;
  let deletionTimer: ReturnType<typeof setTimeout> | undefined;
  let deletionRecovery: Promise<void> | undefined;
  function retryRemoteDeletions() {
    if (stopping || deletionRecovery) return;
    deletionRecovery = recoverMediaDeletions(store, { local: false, continue: () => !stopping }).then(async () => { if (!stopping) await administration.recoverDeletions(); }).finally(() => {
      deletionRecovery = undefined;
      if (!stopping) { deletionTimer = setTimeout(retryRemoteDeletions, 30_000); deletionTimer.unref(); }
    });
  }
  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    const controller = new AbortController();
    const abort = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', abort);
    response.setHeader("X-Request-Id", requestId);
    try {
      const method = request.method ?? "GET";
      const originalPath = new URL(request.url ?? "/", "http://localhost").pathname;
      const path = originalPath === '/api/v1/mcp' || originalPath === '/v1/mcp' ? '/api/mcp' : originalPath.replace(/^\/api\/v1(?=\/|$)/, '/v1');
      const origin = request.headers.origin;
      if (origin && !origins.has(origin)) throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "This browser origin is not allowed. Add it to GRAVITY_ALLOWED_ORIGINS.");
      if (request.headers["sec-fetch-site"] === "cross-site" && !origin) throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "Cross-site requests are not accepted.");
      if (origin) { response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Access-Control-Allow-Credentials", "true"); response.setHeader("Vary", "Origin"); }
      if (method === "OPTIONS") {
        if (!origin) throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "Supply an allowed origin.");
        response.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key, X-Filename, Prefer, MCP-Protocol-Version, MCP-Session-Id, Mcp-Method, Mcp-Name", ...safeHeaders }); response.end(); return;
      }
      response.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Idempotency-Key, X-Gravity-Job-Ids, Location');
      if (path === "/api/health" && method === "GET") return json(response, { status: "ok", version: "0.1.0" });
      const download = path.match(/^\/api\/downloads\/([a-zA-Z0-9_-]{43})$/);
      if (download && method === 'GET') {
        const result = await mediaOperation(() => apiMedia.download(download[1]));
        response.writeHead(200, { ...safeHeaders, 'Content-Type': result.mimeType, 'Content-Length': result.bytes.length }); response.end(result.bytes); return;
      }
      const identity = identify(request, store);
      if (path === "/api/bootstrap" && method === "GET") return json(response, { configured: !!store.owner(), authenticated: !!identity, setupRequired: !store.owner(), setupKeyRequired: true, user: identity?.user });
      const secure = !!origin?.startsWith("https://");
      if (["/api/setup", "/api/login", "/api/invitations/inspect", "/api/invitations/accept"].includes(path) && method === "POST" && !origin) throw new ApiError(403, "ORIGIN_REQUIRED", "Supply an allowed browser Origin header.");
      if (path === "/api/invitations/inspect" && method === "POST") {
        limiter.check(`invitation-inspect:${request.socket.remoteAddress}`);
        const body = await readJson(request, 1024);
        return json(response, { invitation: administration.inspectInvitation(body.token) });
      }
      if (path === "/api/invitations/accept" && method === "POST") {
        limiter.check(`invitation-accept:${request.socket.remoteAddress}`);
        const user = await administration.acceptInvitation(await readJson(request, 4096));
        response.setHeader("Set-Cookie", createSession(store, user, secure));
        return json(response, { user }, 201);
      }
      if (path === "/api/setup" && method === "POST") {
        limiter.check(`setup:${request.socket.remoteAddress}`);
        if (store.owner()) throw new ApiError(409, "ALREADY_CONFIGURED", "This studio already has an owner. Sign in instead.");
        const body = await readJson(request, 4096);
        if (!validSetupKey(body.setupKey, bootstrapSecret)) throw new ApiError(403, "INVALID_SETUP_KEY", "Enter the setup key from storage/setup.key on the server.");
        const credentials = validateCredentials(body);
        const user = store.createOwner(credentials.username, await hashPassword(credentials.password));
        response.setHeader("Set-Cookie", createSession(store, user, secure));
        return json(response, { user }, 201);
      }
      if (path === "/api/login" && method === "POST") {
        const clientId = `login:${request.socket.remoteAddress}`;
        limiter.check(clientId);
        const credentials = validateCredentials(await readJson(request, 4096));
        const user = store.passwordUser(credentials.username);
        if (!await verifyPassword(credentials.password, user?.password)) throw new ApiError(401, "INVALID_CREDENTIALS", "The username or password is incorrect.");
        limiter.reset(clientId);
        response.setHeader("Set-Cookie", createSession(store, user!, secure));
        return json(response, { user: { id: user!.id, username: user!.username, role: user!.role } });
      }
      if (!identity) throw new ApiError(401, "UNAUTHENTICATED", "Sign in to use this studio.");
      const { user } = identity;
      if (!["GET", "HEAD"].includes(method) && identity.source === "session" && !origin) throw new ApiError(403, "ORIGIN_REQUIRED", "Browser changes require an allowed Origin header. Use a bearer token for API clients.");
      const requireSession = () => { if (identity.source !== "session") throw new ApiError(403, "SESSION_REQUIRED", "Sign in through the studio to change server settings."); };
      const requireAdmin = () => { requireSession(); requireAdministrator(store.db, user.id); };
      const hasScope = (scope: ApiScope) => identity.source === 'session' || identity.scopes?.includes(scope) === true;
      const requireScope = (scope: ApiScope) => {
        requireActiveUser(store.db, user.id);
        if (identity.source === 'token') {
          const access = store.apiTokenAccess(digest(request.headers.authorization!.slice(7)));
          if (!access) throw new ApiError(401, 'UNAUTHENTICATED', 'This access token expired or was revoked.');
          if (!access.scopes.includes(scope)) throw new ApiError(403, 'INSUFFICIENT_SCOPE', `This token requires ${scope}.`);
        }
      };
      for (const scope of httpScopes(path, method)) requireScope(scope);
      const adminRoute = path.startsWith("/api/admin/") || /^\/api\/(integrations|runtime|models|settings|hardware|workers)(\/|$)/.test(path)
        || path.startsWith("/api/text/") && !((path === "/api/text/settings" || path === "/api/text/local") && method === "GET");
      if (adminRoute) requireAdmin();
      const readAdminJson = async (limit = 128 * 1024) => { const body = await readJson(request, limit); requireAdmin(); return body; };
      const readAuthorizedJson = async (limit = 128 * 1024) => { const body = await readJson(request, limit); requireActiveUser(store.db, user.id); for (const scope of httpScopes(path, method)) requireScope(scope); if (adminRoute) requireAdmin(); return body; };
      const requireRuntimeIdle = () => { if (runtime.status().busy) throw new ApiError(409, "RUNTIME_BUSY", "Wait for image generation setup to finish before changing settings or models."); };
      const textMeter = () => {
        const taskId = randomUUID(); let metered = false;
        return { authorize: () => requireScope('text:generate'), begin: () => { requireScope('text:generate'); requireWorkTime(store.db, user.id); workTime.beginTask(user.id, taskId, 'local-llm'); metered = true; }, end: () => { if (metered) { workTime.endTask(taskId); metered = false; } } };
      };
      const reply = async (result: Response) => {
        for (const [key, value] of Object.entries(safeHeaders)) response.setHeader(key, value);
        result.headers.forEach((value, key) => response.setHeader(key, value));
        response.writeHead(result.status);
        if (result.body) await pipeline(Readable.fromWeb(result.body as import('node:stream/web').ReadableStream), response);
        else response.end();
      };
      const discovery = async () => ({
        scopes: API_SCOPES.filter(hasScope), endpoints: { mcp: '/api/mcp', openai: '/v1', rest: '/api' },
        models: { images: hasScope('models:read') ? (await engine.catalog()).models.map(({ id, name, ready }) => ({ id, name, ready })) : [], text: hasScope('models:read') ? (await text.gatewayModels(controller.signal)).map(({ id, name }) => ({ id, name, ready: true })) : [] },
        features: { images: hasScope('jobs:write'), editing: hasScope('jobs:write') && hasScope('assets:write'), upscale: hasScope('jobs:write'), backgroundRemoval: hasScope('jobs:write'), chat: hasScope('text:generate') },
      });
      if (path === '/api/access' && method === 'GET') return json(response, await discovery());
      if (path.startsWith('/v1/')) {
        if (stopping) throw new ApiError(503, 'STUDIO_STOPPING', 'The Studio is restarting. Try again shortly.');
        if ((path === '/v1/models' || path.startsWith('/v1/models/')) && method === 'GET') {
          requireScope('models:read');
          const [catalog, language] = await Promise.all([engine.catalog(), text.gatewayModels(controller.signal)]);
          const data = [...catalog.models.map(model => ({ id: model.id, object: 'model', created: 0, owned_by: 'gravity-studio', name: model.name, type: 'image', ready: model.ready, capabilities: model.capabilities })), ...language];
          requireScope('models:read');
          if (path === '/v1/models') return json(response, { object: 'list', data });
          let id: string; try { id = decodeURIComponent(path.slice('/v1/models/'.length)); } catch { throw new ApiError(400, 'INVALID_MODEL_ID', 'Supply a model ID from /v1/models.'); }
          const model = data.find(model => model.id === id);
          if (!model) throw new ApiError(404, 'MODEL_NOT_FOUND', 'This model is not available in Studio.');
          return json(response, model);
        }
        if (path === '/v1/chat/completions' && method === 'POST') {
          requireScope('text:generate'); const body = parseChatRequest(await readAuthorizedJson(1024 * 1024)); requireScope('text:generate');
          if (text.gatewayLocal(body.model)) requireWorkTime(store.db, user.id);
          return await reply(await openaiChat(text, body, controller.signal, textMeter()));
        }
        if (['/v1/images/generations', '/v1/images/edits'].includes(path) && method === 'POST') {
          const editing = path.endsWith('/edits');
          const authorize = () => { requireScope('jobs:write'); requireScope('assets:read'); if (editing) requireScope('assets:write'); };
          authorize();
          const body = await imageBody(await readBytes(request, OPENAI_IMAGE_BODY_LIMIT), request.headers['content-type'] || '');
          const forwardedOrigin = `${request.headers['x-forwarded-proto']}://${request.headers['x-forwarded-host']}`;
          const publicOrigin = origins.has(forwardedOrigin) ? forwardedOrigin : origin || invitationOrigin || 'http://127.0.0.1:4321';
          return await mediaOperation(async () => reply(await openaiImages({ engine, store, media: apiMedia, userId: user.id, body, editing, signal: controller.signal, origin: publicOrigin, key: request.headers['idempotency-key'] as string | undefined, asynchronous: typeof request.headers.prefer === 'string' && request.headers.prefer.split(',').some(value => value.trim() === 'respond-async'), authorize })));
        }
        if (path === '/v1/files' && method === 'POST') {
          requireScope('assets:write');
          const body = await imageBody(await readBytes(request, MAX_INPUT_BYTES + 64 * 1024), request.headers['content-type'] || '');
          if (!(body.file instanceof File) || body.purpose !== 'vision' || Object.keys(body).some(key => !['file', 'purpose'].includes(key))) throw new ApiError(400, 'INVALID_FILE', 'Upload an image file with purpose=vision.');
          const suppliedKey = request.headers['idempotency-key'];
          if (suppliedKey !== undefined && (typeof suppliedKey !== 'string' || !/^[a-zA-Z0-9_.:-]{8,128}$/.test(suppliedKey))) throw new ApiError(400, 'INVALID_REQUEST_KEY', 'Use a request key of 8–128 letters, digits, dots, underscores, colons or dashes.');
          const file = body.file; requireScope('assets:write');
          const input = await mediaOperation(async () => apiMedia.upload(user.id, Buffer.from(await file.arrayBuffer()), file.name, `file:${hash(suppliedKey ?? randomUUID())}`));
          return json(response, { id: input.id, object: 'file', bytes: store.input(input.id, user.id).bytes, created_at: 0, filename: input.name, purpose: 'vision' }, 200);
        }
        if (path === '/v1/files' && method === 'GET') {
          requireScope('assets:read');
          return json(response, { object: 'list', data: store.inputs(user.id).map(input => ({ id: input.id, object: 'file', bytes: store.input(input.id, user.id).bytes, created_at: 0, filename: input.name, purpose: 'vision' })), has_more: false });
        }
        const fileRoute = path.match(/^\/v1\/files\/([a-f0-9-]{36})(\/content)?$/);
        if (fileRoute && (method === 'GET' || method === 'DELETE' && !fileRoute[2])) {
          requireScope(method === 'GET' ? 'assets:read' : 'assets:delete');
          if (method === 'DELETE') { await mediaOperation(() => deleteInput(store, fileRoute[1], user.id)); return json(response, { id: fileRoute[1], object: 'file', deleted: true }); }
          const input = store.input(fileRoute[1], user.id);
          if (fileRoute[2]) { const bytes = await mediaOperation(() => inputBytes(store, input.id, user.id)); response.writeHead(200, { ...safeHeaders, 'Content-Type': input.mimeType, 'Content-Length': bytes.length }); response.end(bytes); return; }
          return json(response, { id: input.id, object: 'file', bytes: input.bytes, created_at: 0, filename: input.name, purpose: 'vision' });
        }
        throw new ApiError(404, 'UNSUPPORTED_ENDPOINT', 'This Studio supports models, chat/completions, images/generations, images/edits and image files.');
      }
      if (path === "/api/work-time" && method === "GET") return json(response, workTime.view(user.id));
      if (path.startsWith("/api/admin/")) {
        requireAdmin();
        if (stopping) throw new ApiError(503, "STUDIO_STOPPING", "The studio is restarting. Try again shortly.");
        if (path === "/api/admin/users" && method === "GET") return json(response, { users: administration.users() });
        if (path === "/api/admin/storage" && method === "GET") {
          const usage = await mediaOperation(() => storageUsage.view());
          requireAdmin();
          return json(response, usage);
        }
        const adminUserRoute = path.match(/^\/api\/admin\/users\/([a-f0-9-]{36})(\/work-time)?$/);
        if (adminUserRoute) {
          const id = adminUserRoute[1];
          if (adminUserRoute[2]) {
            administration.user(id);
            if (method === "GET") return json(response, workTime.view(id));
            if (method === "POST") {
              const body = await readAdminJson(4096);
              return json(response, workTime.adjust(user.id, id, body.deltaMs as number, body.reason as string, body.idempotencyKey as string));
            }
          } else {
            if (method === "PATCH") return json(response, { user: administration.update(user.id, id, await readAdminJson(4096)) });
            if (method === "DELETE") {
              const body = await readAdminJson(4096);
              await mediaOperation(() => administration.deleteUser(user.id, id, body));
              return json(response, { deleted: true });
            }
          }
        }
        if (path === "/api/admin/work-time" && method === "GET") return json(response, { users: workTime.list() });
        if (path === "/api/admin/invitations") {
          if (method === "GET") return json(response, { invitations: administration.invitations() });
          if (method === "POST") {
            const publicOrigin = origin ?? invitationOrigin;
            if (!publicOrigin) throw new ApiError(503, "INVITATION_ORIGIN_REQUIRED", "Configure the public Studio address in GRAVITY_ALLOWED_ORIGINS before creating invitations.");
            const created = administration.createInvitation(user.id, await readAdminJson(4096));
            let invitation = created.invitation, deliveryError: string | undefined;
            if (created.sendEmail) {
              try {
                await mail.sendInvitation({ to: invitation.email!, inviteId: invitation.id, token: created.token, expiresAt: invitation.expiresAt }, publicOrigin);
                invitation = administration.delivery(invitation.id, "sent");
              } catch {
                invitation = administration.delivery(invitation.id, "failed");
                deliveryError = "The email could not be confirmed as sent. Copy the invitation link, or check Mail settings before creating another invitation.";
              }
            }
            return json(response, { invitation, url: `${publicOrigin}/invite#token=${created.token}`, ...(deliveryError ? { deliveryError } : {}) }, 201);
          }
        }
        const inviteRoute = path.match(/^\/api\/admin\/invitations\/([a-f0-9-]{36})$/);
        if (inviteRoute && method === "DELETE") { administration.revokeInvitation(user.id, inviteRoute[1]); return json(response, { revoked: true }); }
        if (path === "/api/admin/mail") {
          if (method === "GET") return json(response, mail.view());
          if (method === "PUT") return json(response, mail.save(await readAdminJson(16_384)));
        }
        const mailCredentialRoute = path.match(/^\/api\/admin\/mail\/credentials\/([^/]+)$/);
        if (mailCredentialRoute && method === "DELETE") { const body = await readAdminJson(1024); return json(response, mail.removeSecret(mailCredentialRoute[1], body.revision)); }
        if (path === "/api/admin/mail/test" && method === "POST") return json(response, await mail.sendTest(await readAdminJson(1024)));
      }
      if (path === "/api/account") {
        requireSession();
        if (method === "GET") return json(response, accountView(store, user));
        if (method === "PUT") return json(response, saveAccount(store, user, await readAuthorizedJson(4096)));
      }
      if (path.startsWith("/api/text/") || path === "/api/prompts/refine") {
        if (path !== '/api/prompts/refine') requireSession();
        if (stopping) throw new ApiError(503, "STUDIO_STOPPING", "The studio is restarting. Try again shortly.");
        if (path === '/api/text/local') {
          if (method === 'GET') {
            const status = await localText.status();
            return json(response, user.role === "admin" ? status : { ...status, error: status.error ? "The local assistant is unavailable. Contact your administrator." : null, message: status.busy ? "The local assistant is busy" : status.ready ? "The local assistant is ready" : "The local assistant is unavailable", gpuId: null, gpuIds: [], gpus: [] });
          }
          if (method === 'POST') return json(response, await localText.prepare(await readAuthorizedJson(1024)), 202);
          if (method === 'PUT') return json(response, await localText.configure(await readAuthorizedJson(8192)));
        }
        if (path === '/api/text/local/unload' && method === 'POST') {
          const body = await readAuthorizedJson(1024);
          if (Object.keys(body).length) throw new ApiError(400, 'INVALID_LOCAL_TEXT_REQUEST', 'Unload the local model with an empty object.');
          return json(response, await localText.release());
        }
        if (path === "/api/text/settings" && method === "GET") { const settings = text.settings(); return json(response, user.role === "admin" ? settings : { revision: settings.revision, assistant: settings.assistant }); }
        if (path === "/api/text/connection" && method === "PUT") return json(response, text.saveConnection(await readAuthorizedJson(8192)));
        if (path === "/api/text/assistant" && method === "PUT") return json(response, await text.saveAssistant(await readAuthorizedJson(2048)));
        if ((path === "/api/text/models" && method === "GET") || (path === "/api/prompts/refine" && method === "POST")) {
          const controller = new AbortController();
          const abort = () => { if (!response.writableEnded) controller.abort(); };
          response.once("close", abort);
          try {
            const body = path === "/api/prompts/refine" ? await readAuthorizedJson() : undefined;
            if (body && identity.source === 'token' && body.settingsRevision === undefined) body.settingsRevision = text.settings().revision;
            const local = body && text.settings().assistant?.provider === "local";
            if (local) requireWorkTime(store.db, user.id);
            const result = path === "/api/text/models"
              ? await text.models(new URL(request.url!, "http://localhost").searchParams.get("provider"), controller.signal, new URL(request.url!, "http://localhost").searchParams.get("refresh") === "true")
              : await text.refine(body, controller.signal, textMeter());
            if (!controller.signal.aborted) return json(response, result);
            return;
          } finally { response.off("close", abort); }
        }
      }
      if (path === "/api/integrations" && method === "GET") {
        requireSession();
        return json(response, { providers: INTEGRATION_PROVIDERS.map(provider => ({ ...provider, credential: credentials.status(provider.id) })) });
      }
      const integrationRoute = path.match(/^\/api\/integrations\/([^/]+)(\/test)?$/);
      if (integrationRoute) {
        requireSession();
        const provider = integrationProvider(integrationRoute[1]);
        const view = () => ({ ...INTEGRATION_PROVIDERS.find(item => item.id === provider)!, credential: credentials.status(provider) });
        if (!integrationRoute[2] && method === "PUT") {
          const body = await readAuthorizedJson(8192);
          if (Object.keys(body).length !== 1 || !("apiKey" in body)) throw new ApiError(400, "INVALID_INTEGRATION_KEY", "Supply only the API key with { apiKey: string }.");
          credentials.set(provider, body.apiKey);
          return json(response, view());
        }
        if (!integrationRoute[2] && method === "DELETE") { credentials.delete(provider); return json(response, view()); }
        if (integrationRoute[2] && method === "POST") {
          const body = await readAuthorizedJson(1024);
          if (Object.keys(body).length) throw new ApiError(400, "INVALID_INTEGRATION_TEST", "Check the saved API key with an empty object.");
          if (stopping) throw new ApiError(503, "STUDIO_STOPPING", "The studio is restarting. Try again shortly.");
          if (integrationChecks.has(provider)) throw new ApiError(409, "INTEGRATION_CHECK_BUSY", "This connection is already being checked. Wait for the result.");
          const key = credentials.get(provider);
          if (!key) throw new ApiError(409, "INTEGRATION_KEY_REQUIRED", "Save an API key before checking this connection.");
          const check = testIntegration(provider, key, options.integrationFetch);
          integrationChecks.set(provider, check);
          try {
            const result = await check;
            if (credentials.get(provider) !== key) throw new ApiError(409, "INTEGRATION_KEY_CHANGED", "The saved key changed during this check. Check the connection again.");
            return json(response, result);
          } finally { integrationChecks.delete(provider); }
        }
      }
      if (path === "/api/runtime") {
        requireSession();
        if (method === "GET") return json(response, runtime.status());
        if (method === "POST") {
          const body = await readAuthorizedJson(16384);
          if (models.busy()) throw new ApiError(409, "MODEL_DOWNLOAD_BUSY", "Wait for the model download to finish before changing GPUs.");
          await localText.evictIdle();
          requireAdmin();
          return json(response, runtime.start(body), 202);
        }
      }
      if (path === "/api/models/library" && method === "GET") { requireSession(); return json(response, await models.view()); }
      if (path === "/api/models/access" && method === "POST") {
        requireSession();
        if (stopping) throw new ApiError(503, "STUDIO_STOPPING", "The studio is restarting. Try again shortly.");
        const controller = new AbortController();
        const abort = () => { if (!response.writableEnded) controller.abort(); };
        response.once("close", abort);
        try {
          const result = await models.checkAccess(await readAuthorizedJson(32 * 1024), controller.signal);
          if (!controller.signal.aborted) return json(response, result);
          return;
        } finally { response.off("close", abort); }
      }
      if (path === "/api/models/download" && method === "POST") { requireSession(); const body = await readAuthorizedJson(32 * 1024); requireRuntimeIdle(); return json(response, models.start(body), 202); }
      if (path === "/api/models/activate" && method === "POST") { requireSession(); const body = await readAuthorizedJson(1024); requireRuntimeIdle(); return json(response, await models.activate(body)); }
      if (path === "/api/mcp") {
        if (method !== "POST") { response.setHeader("Allow", "POST"); throw new ApiError(405, "METHOD_NOT_ALLOWED", "This stateless MCP endpoint accepts POST requests."); }
        const body = await readAuthorizedJson(Math.ceil(MCP_INLINE_INPUT_BYTES / 3) * 4 + 128 * 1024);
        const headers = new Headers();
        for (const name of ["content-type", "accept", "mcp-protocol-version", "mcp-session-id", "mcp-method", "mcp-name"]) {
          const value = request.headers[name]; if (typeof value === "string") headers.set(name, value);
        }
        const result = await mediaOperation(() => mcpResponse(engine, store, user.id, new Request("http://localhost/api/mcp", { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal }), body, {
          hasScope, requireScope, signal: controller.signal, mediaOperation, capabilities: discovery,
          upload: input => apiMedia.inline(user.id, input),
          textModels: () => text.gatewayModels(controller.signal),
          chat: async (body, signal) => { requireScope('text:generate'); const parsed = parseChatRequest(body); if (text.gatewayLocal(parsed.model)) requireWorkTime(store.db, user.id); const result = await openaiChat(text, parsed, signal, textMeter()); return result.json(); },
          refine: (body, signal) => { requireScope('text:generate'); return text.refine({ ...body, settingsRevision: text.settings().revision }, signal, textMeter()); },
        }));
        return await reply(result);
      }
      if (path === "/api/logout" && method === "POST") {
        const token = cookieToken(request); if (token) store.revokeSession(digest(token));
        response.setHeader("Set-Cookie", clearSession(secure)); return json(response, { loggedOut: true });
      }
      if (path === "/api/hardware" && method === "GET") return json(response, await engine.hardwareReport(true));
      if (path === "/api/settings") {
        requireSession();
        if (method === "GET") return json(response, { ...settingsView(store), managedWorkers: await runtime.managedWorkers() });
        if (method === "PUT") {
          requireRuntimeIdle();
          const body = await readAuthorizedJson();
          const [hardware, managedWorkers] = await Promise.all([engine.hardwareReport(true), runtime.managedWorkers()]);
          const settings = validateSettings(body, hardware, modelRegistry(store));
          requireAdmin();
          requireRuntimeIdle();
          const current = store.settings();
          protectManagedWorkers(current, settings, managedWorkers);
          const changedConcurrency = settings.policy.maxConcurrentJobs !== current.policy.maxConcurrentJobs;
          const saved = store.saveSettings(settings);
          if (changedConcurrency) store.setMetadata("runtime-auto-concurrency", false);
          engine.invalidateWorkers();
          void engine.refreshWorkers(true);
          return json(response, { ...saved, managedWorkers });
        }
      }
      if (path === "/api/workers/probe" && method === "POST") {
        requireSession();
        const body = await readAuthorizedJson(4096);
        return json(response, await engine.probe(String(body.baseUrl ?? "")));
      }
      const unloadWorkerRoute = path.match(/^\/api\/workers\/([^/]+)\/unload$/);
      if (unloadWorkerRoute && method === "POST") {
        requireSession();
        if (stopping) throw new ApiError(503, "STUDIO_STOPPING", "The studio is restarting. Try again shortly.");
        requireRuntimeIdle();
        const body = await readAuthorizedJson(1024);
        if (Object.keys(body).length) throw new ApiError(400, "INVALID_WORKER_RELEASE", "Release worker memory with an empty object.");
        let workerId: string;
        try { workerId = decodeURIComponent(unloadWorkerRoute[1]); }
        catch { throw new ApiError(400, "INVALID_WORKER_ID", "Choose a configured worker."); }
        if (stopping) throw new ApiError(503, "STUDIO_STOPPING", "The studio is restarting. Try again shortly.");
        requireRuntimeIdle();
        return json(response, await engine.releaseWorkerMemory(workerId));
      }
      if (path === "/api/catalog" && method === "GET") return json(response, await engine.catalog());
      if (path === "/api/generation-tools" && method === "GET") return json(response, await engine.generationTools(new URL(request.url!, "http://localhost").searchParams.get("modelId") ?? undefined));
      if (path === "/api/background-removal" && method === "GET") return json(response, await engine.backgroundRemoval());
      if (path === "/api/background-removal" && method === "POST") {
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string") throw new ApiError(400, "REQUEST_KEY_REQUIRED", "Supply an Idempotency-Key so retries cannot create duplicate cutouts.");
        return json(response, { job: await engine.submitBackgroundRemoval(user.id, await readAuthorizedJson(), key) }, 202);
      }
      if (path === "/api/upscalers" && method === "GET") return json(response, await engine.upscalers());
      if (path === "/api/upscale" && method === "POST") {
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string") throw new ApiError(400, "REQUEST_KEY_REQUIRED", "Supply an Idempotency-Key so retries cannot create duplicate upscales.");
        return json(response, { job: await engine.submitUpscale(user.id, await readAuthorizedJson(), key) }, 202);
      }
      if (path === "/api/state" && method === "GET") {
        const state = await engine.state(user.id);
        if (user.role !== "admin" || identity.source === 'token') {
          state.workers = state.workers.map(worker => ({ ...worker, baseUrl: "", deviceIds: [], canRelease: false, error: worker.error ? "Worker unavailable" : undefined }));
          state.hardware = { ...state.hardware, host: { ...state.hardware.host, container: { detected: false, markers: [] } }, diagnostics: [], gpus: state.hardware.gpus.map(gpu => ({ ...gpu, pciAddress: null, uuid: null, driverVersion: null })) };
        }
        return json(response, state);
      }
      if (path === "/api/favorites" && method === "GET") return json(response, { jobs: store.favorites(user.id).map(publicJob) });
      if (path === "/api/jobs") {
        if (method === "GET") return json(response, { jobs: store.jobs(user.id).map(publicJob) });
        if (method === "POST") {
          const key = request.headers["idempotency-key"];
          if (typeof key !== "string") throw new ApiError(400, "REQUEST_KEY_REQUIRED", "Supply an Idempotency-Key so retries cannot create duplicate generations.");
          const body = await readAuthorizedJson();
          if (body.images !== undefined || body.maskId !== undefined) requireScope('assets:read');
          return json(response, { job: await engine.submit(user.id, body, key) }, 202);
        }
      }
      const jobRoute = path.match(/^\/api\/jobs\/([a-f0-9-]{36})$/);
      if (jobRoute && method === "GET") return json(response, { job: publicJob(store.job(jobRoute[1], user.id)) });
      const cancelRoute = path.match(/^\/api\/jobs\/([a-f0-9-]{36})\/cancel$/);
      if (cancelRoute && method === "POST") { await readAuthorizedJson(1024); return json(response, { job: engine.cancel(user.id, cancelRoute[1]) }); }
      const resolveRoute = path.match(/^\/api\/jobs\/([a-f0-9-]{36})\/resolve$/);
      if (resolveRoute && method === "POST") {
        requireSession();
        const body = await readAuthorizedJson(1024);
        if (body.acknowledge !== true || Object.keys(body).some(key => key !== "acknowledge")) throw new ApiError(400, "ACKNOWLEDGEMENT_REQUIRED", "Acknowledge closing this unknown generation with { acknowledge: true }.");
        return json(response, { job: await engine.resolve(user.id, resolveRoute[1]) });
      }
      if (path === "/api/inputs/from-output" && method === "POST") {
        const body = await readAuthorizedJson(1024);
        return json(response, await mediaOperation(() => saveInputFromOutput(store, user.id, body)), 201);
      }
      if (path === "/api/inputs") {
        if (method === "GET") return json(response, { inputs: store.inputs(user.id) });
        if (method === "POST") {
          const suppliedName = request.headers["x-filename"];
          let name = typeof suppliedName === "string" ? suppliedName : "reference.png";
          try { name = decodeURIComponent(name); } catch { /* Plain filenames containing % remain valid. */ }
          const input = await mediaOperation(async () => saveInput(store, user.id, await readBytes(request, MAX_INPUT_BYTES), name));
          return json(response, input, 201);
        }
      }
      const inputRoute = path.match(/^\/api\/inputs\/([a-f0-9-]{36})$/);
      if (inputRoute && method === "DELETE") {
        await mediaOperation(() => deleteInput(store, inputRoute[1], user.id));
        return json(response, { deleted: true });
      }
      if (inputRoute && method === "GET") {
        const input = store.input(inputRoute[1], user.id);
        await mediaOperation(async () => {
          const bytes = input.object !== undefined ? await inputBytes(store, input.id, user.id) : null;
          if (!bytes && !input.path) throw new ApiError(503, "MEDIA_STORAGE_UNAVAILABLE", "This reference image has no available storage location.");
          response.writeHead(200, { ...safeHeaders, "Content-Type": input.mimeType, "Content-Length": input.bytes });
          if (bytes) response.end(bytes); else await pipeline(createReadStream(input.path!), response);
        }); return;
      }
      const favoriteRoute = path.match(/^\/api\/jobs\/([a-f0-9-]{36})\/outputs\/([a-f0-9]{32})\/favorite$/);
      if (favoriteRoute && method === "PUT") {
        const body = await readAuthorizedJson(1024);
        if (typeof body.favorite !== "boolean" || Object.keys(body).some(key => key !== "favorite")) throw new ApiError(400, "INVALID_FAVORITE", "Set whether this image is a favorite with { favorite: true } or { favorite: false }.");
        return json(response, { job: publicJob(store.setOutputFavorite(favoriteRoute[1], favoriteRoute[2], user.id, body.favorite)) });
      }
      const outputRoute = path.match(/^\/api\/jobs\/([a-f0-9-]{36})\/outputs\/([a-f0-9]{32})$/);
      if (outputRoute && method === "DELETE") return json(response, { job: publicJob(await mediaOperation(() => deleteOutput(store, outputRoute[1], outputRoute[2], user.id))) });
      if (outputRoute && method === "GET") {
        const output = store.output(outputRoute[1], outputRoute[2], user.id);
        await mediaOperation(async () => {
          const bytes = output.object !== undefined ? await outputBytes(store, outputRoute[1], output.id, user.id) : null;
          if (!bytes && !output.path) throw new ApiError(503, "MEDIA_STORAGE_UNAVAILABLE", "This image has no available storage location.");
          response.writeHead(200, { ...safeHeaders, "Content-Type": output.mimeType, "Content-Length": output.bytes, "Content-Disposition": `inline; filename="${output.id}.${output.mimeType.split("/")[1]}"` });
          if (bytes) response.end(bytes); else await pipeline(createReadStream(output.path!), response);
        }); return;
      }
      if (path === "/api/tokens") {
        requireSession();
        if (method === "GET") return json(response, { tokens: store.apiTokens(user.id) });
        if (method === "POST") {
          const body = await readAuthorizedJson(4096);
          if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 80) throw new ApiError(400, "INVALID_TOKEN_NAME", "Give this token a name of up to 80 characters.");
          const token = `gs_${randomBytes(32).toString("base64url")}`;
          return json(response, { ...store.saveApiToken(user.id, body.name.trim(), digest(token), tokenOptions(body)), token }, 201);
        }
      }
      const tokenRoute = path.match(/^\/api\/tokens\/([a-f0-9-]{36})$/);
      if (tokenRoute && method === "DELETE") { requireSession(); store.revokeApiToken(user.id, tokenRoute[1]); return json(response, { revoked: true }); }
      throw new ApiError(404, "NOT_FOUND", "This API operation does not exist.");
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof ApiError ? error.status : error instanceof InferenceError ? error.code === "COMFY_UNREACHABLE" ? 503 : 400 : 500;
      if (status === 500) console.error("Request failed:", requestId, error);
      if (status === 401) response.setHeader('WWW-Authenticate', 'Bearer realm="gravity-studio"');
      const compatible = /^\/(?:api\/)?v1(?:\/|$)/.test(request.url ?? '') && !/^\/(?:api\/)?v1\/mcp(?:\?|$)/.test(request.url ?? '');
      json(response, { error: { code: error instanceof ApiError || error instanceof InferenceError ? error.code : "INTERNAL_ERROR", message: status === 500 ? "The server could not complete this request." : (error as Error).message, ...(compatible ? { type: status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'server_error' : 'invalid_request_error', param: null } : {}), ...(error instanceof ImageRequestError ? { job_ids: error.jobIds } : {}) }, requestId }, status);
    } finally { response.off('close', abort); }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5000;
  server.once('listening', retryRemoteDeletions);
  return Object.assign(server, { closeOperations: async () => {
    stopping = true; clearTimeout(deletionTimer);
    const failures: unknown[] = [];
    try { await text.close(); } catch (error) { failures.push(error); }
    try { await mail.close(); } catch (error) { failures.push(error); }
    const drained = await Promise.allSettled([localText.close(), runtime.close(), models.close(), Promise.allSettled(integrationChecks.values()), Promise.allSettled(mediaOperations), deletionRecovery]);
    for (const result of drained) if (result.status === 'rejected') failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, 'Studio operations could not shut down cleanly.');
  } });
}
