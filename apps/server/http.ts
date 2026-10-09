import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { ApiError } from "../../packages/contracts/index.ts";
import { InferenceError } from "../../packages/inference/index.ts";
import { Engine } from "./engine.ts";
import { Store, publicJob } from "./store.ts";
import { cookieToken, createSession, clearSession, digest, hashPassword, identify, LoginLimiter, setupKey, validSetupKey, validateCredentials, verifyPassword } from "./auth.ts";
import { MAX_INPUT_BYTES, saveInput } from "./media.ts";
import { settingsView, validateSettings } from "./settings.ts";

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
export interface ServerOptions {
  store: Store;
  engine: Engine;
  allowedOrigins: string[];
  setupSecret?: string;
}
export async function createStudioServer(options: ServerOptions) {
  const { store, engine } = options;
  const bootstrapSecret = options.setupSecret ?? await setupKey(store.directory);
  const limiter = new LoginLimiter();
  const origins = new Set(options.allowedOrigins.map(origin => new URL(origin).origin));
  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    response.setHeader("X-Request-Id", requestId);
    try {
      const method = request.method ?? "GET";
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const origin = request.headers.origin;
      if (origin && !origins.has(origin)) throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "This browser origin is not allowed. Add it to GRAVITY_ALLOWED_ORIGINS.");
      if (request.headers["sec-fetch-site"] === "cross-site" && !origin) throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "Cross-site requests are not accepted.");
      if (origin) { response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Access-Control-Allow-Credentials", "true"); response.setHeader("Vary", "Origin"); }
      if (method === "OPTIONS") {
        if (!origin) throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "Supply an allowed origin.");
        response.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key, X-Filename", ...safeHeaders }); response.end(); return;
      }
      if (path === "/api/health" && method === "GET") return json(response, { status: "ok", version: "0.1.0" });
      const identity = identify(request, store);
      if (path === "/api/bootstrap" && method === "GET") return json(response, { configured: !!store.owner(), authenticated: !!identity, setupRequired: !store.owner(), setupKeyRequired: true, user: identity?.user });
      const secure = !!origin?.startsWith("https://");
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
        return json(response, { user: { id: user!.id, username: user!.username } });
      }
      if (!identity) throw new ApiError(401, "UNAUTHENTICATED", "Sign in to use this studio.");
      const { user } = identity;
      if (!["GET", "HEAD"].includes(method) && identity.source === "session" && !origin) throw new ApiError(403, "ORIGIN_REQUIRED", "Browser changes require an allowed Origin header. Use a bearer token for API clients.");
      const requireSession = () => { if (identity.source !== "session") throw new ApiError(403, "SESSION_REQUIRED", "Sign in through the studio to change server settings."); };
      if (path === "/api/logout" && method === "POST") {
        const token = cookieToken(request); if (token) store.revokeSession(digest(token));
        response.setHeader("Set-Cookie", clearSession(secure)); return json(response, { loggedOut: true });
      }
      if (path === "/api/hardware" && method === "GET") return json(response, await engine.hardwareReport(true));
      if (path === "/api/settings") {
        requireSession();
        if (method === "GET") return json(response, settingsView(store));
        if (method === "PUT") {
          const settings = validateSettings(await readJson(request), await engine.hardwareReport(true));
          const saved = store.saveSettings(settings);
          engine.invalidateWorkers();
          void engine.refreshWorkers(true);
          return json(response, saved);
        }
      }
      if (path === "/api/workers/probe" && method === "POST") {
        requireSession();
        const body = await readJson(request, 4096);
        return json(response, await engine.probe(String(body.baseUrl ?? "")));
      }
      if (path === "/api/catalog" && method === "GET") return json(response, await engine.catalog());
      if (path === "/api/state" && method === "GET") return json(response, await engine.state(user.id));
      if (path === "/api/jobs") {
        if (method === "GET") return json(response, { jobs: store.jobs(user.id).map(publicJob) });
        if (method === "POST") {
          const key = request.headers["idempotency-key"];
          if (typeof key !== "string") throw new ApiError(400, "REQUEST_KEY_REQUIRED", "Supply an Idempotency-Key so retries cannot create duplicate generations.");
          return json(response, { job: await engine.submit(user.id, await readJson(request), key) }, 202);
        }
      }
      const jobRoute = path.match(/^\/api\/jobs\/([a-f0-9-]{36})$/);
      if (jobRoute && method === "GET") return json(response, { job: publicJob(store.job(jobRoute[1], user.id)) });
      const cancelRoute = path.match(/^\/api\/jobs\/([a-f0-9-]{36})\/cancel$/);
      if (cancelRoute && method === "POST") { await readJson(request, 1024); return json(response, { job: engine.cancel(user.id, cancelRoute[1]) }); }
      if (path === "/api/inputs") {
        if (method === "GET") return json(response, { inputs: store.inputs(user.id) });
        if (method === "POST") {
          const name = request.headers["x-filename"];
          const input = await saveInput(store, user.id, await readBytes(request, MAX_INPUT_BYTES), typeof name === "string" ? name : "reference.png");
          return json(response, input, 201);
        }
      }
      const inputRoute = path.match(/^\/api\/inputs\/([a-f0-9-]{36})$/);
      if (inputRoute && method === "GET") {
        const input = store.input(inputRoute[1], user.id);
        response.writeHead(200, { ...safeHeaders, "Content-Type": input.mimeType, "Content-Length": input.bytes });
        await pipeline(createReadStream(input.path), response); return;
      }
      const outputRoute = path.match(/^\/api\/jobs\/([a-f0-9-]{36})\/outputs\/([a-f0-9]{32})$/);
      if (outputRoute && method === "GET") {
        const output = store.output(outputRoute[1], outputRoute[2], user.id);
        response.writeHead(200, { ...safeHeaders, "Content-Type": output.mimeType, "Content-Length": output.bytes, "Content-Disposition": `inline; filename="${output.id}.${output.mimeType.split("/")[1]}"` });
        await pipeline(createReadStream(output.path), response); return;
      }
      if (path === "/api/tokens") {
        requireSession();
        if (method === "GET") return json(response, { tokens: store.apiTokens(user.id) });
        if (method === "POST") {
          const body = await readJson(request, 4096);
          if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 80) throw new ApiError(400, "INVALID_TOKEN_NAME", "Give this token a name of up to 80 characters.");
          const token = `gs_${randomBytes(32).toString("base64url")}`;
          return json(response, { ...store.saveApiToken(user.id, body.name.trim(), digest(token)), token }, 201);
        }
      }
      const tokenRoute = path.match(/^\/api\/tokens\/([a-f0-9-]{36})$/);
      if (tokenRoute && method === "DELETE") { requireSession(); store.revokeApiToken(user.id, tokenRoute[1]); return json(response, { revoked: true }); }
      throw new ApiError(404, "NOT_FOUND", "This API operation does not exist.");
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof ApiError ? error.status : error instanceof InferenceError ? error.code === "COMFY_UNREACHABLE" ? 503 : 400 : 500;
      if (status === 500) console.error("Request failed:", requestId, error);
      json(response, { error: { code: error instanceof ApiError || error instanceof InferenceError ? error.code : "INTERNAL_ERROR", message: status === 500 ? "The server could not complete this request." : (error as Error).message }, requestId }, status);
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5000;
  return server;
}
