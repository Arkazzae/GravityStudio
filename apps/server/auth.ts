import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { ApiError, type Owner } from "../../packages/contracts/index.ts";
import type { Store } from "./store.ts";
import type { ApiScope } from '../../packages/contracts/access.ts';

export const SESSION_COOKIE = "gravity_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 ** 2 }, (error, key) => error ? reject(error) : resolve(key));
});
export function validateCredentials(value: unknown): { username: string; password: string } {
  if (!value || typeof value !== "object") throw new ApiError(400, "INVALID_CREDENTIALS", "Enter your username and password.");
  const { username, password } = value as Record<string, unknown>;
  if (typeof username !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/.test(username)) throw new ApiError(400, "INVALID_USERNAME", "Use 3–64 letters, numbers, dots, dashes or underscores for your username.");
  if (typeof password !== "string" || password.length < 12 || password.length > 256) throw new ApiError(400, "INVALID_PASSWORD", "Use a password between 12 and 256 characters.");
  return { username: username.toLowerCase(), password };
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `scrypt-v1:${salt}:${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, hash?: string): Promise<boolean> {
  // Unknown accounts still perform the password derivation.
  const [, salt, expected] = hash?.split(":") ?? ["scrypt-v1", "00000000000000000000000000000000", "00".repeat(64)];
  const actual = await derive(password, salt);
  const bytes = Buffer.from(expected, "hex");
  return !!hash && bytes.length === actual.length && timingSafeEqual(bytes, actual);
}
export async function setupKey(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "setup.key");
  try { return (await readFile(path, "utf8")).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const key = randomBytes(32).toString("base64url");
  try { await writeFile(path, key + "\n", { mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return (await readFile(path, "utf8")).trim(); throw error; }
  return key;
}
export function validSetupKey(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== "string" || supplied.length > 256) return false;
  return timingSafeEqual(Buffer.from(digest(supplied)), Buffer.from(digest(expected)));
}
export function cookieToken(request: IncomingMessage): string | undefined {
  return request.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
}
export function identify(request: IncomingMessage, store: Store): { user: Owner; source: "session" | "token"; scopes?: ApiScope[]; tokenId?: string } | undefined {
  const authorization = request.headers.authorization;
  if (authorization) {
    if (!authorization.startsWith("Bearer ") || authorization.length > 256) return undefined;
    const access = store.apiTokenAccess(digest(authorization.slice(7)));
    return access ? { ...access, source: "token" } : undefined;
  }
  const token = cookieToken(request);
  const user = token && token.length <= 256 ? store.session(digest(token)) : undefined;
  return user ? { user, source: "session" } : undefined;
}
export function createSession(store: Store, user: Owner, secure: boolean): string {
  const token = randomBytes(32).toString("base64url");
  store.saveSession(digest(token), user.id, Date.now() + SESSION_SECONDS * 1000);
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`;
}
export function clearSession(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}
export class LoginLimiter {
  attempts = new Map<string, { count: number; resetsAt: number }>();
  check(key: string) {
    const at = Date.now();
    for (const [id, value] of this.attempts) if (value.resetsAt <= at) this.attempts.delete(id);
    if (this.attempts.size >= 10000 && !this.attempts.has(key)) throw new ApiError(429, "RATE_LIMITED", "Too many sign-in attempts. Try again later.");
    const current = this.attempts.get(key) ?? { count: 0, resetsAt: at + 15 * 60_000 };
    current.count++;
    this.attempts.set(key, current);
    if (current.count > 10) throw new ApiError(429, "RATE_LIMITED", "Too many sign-in attempts. Try again in 15 minutes.");
  }
  reset(key: string) { this.attempts.delete(key); }
}
