import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from '../../packages/contracts/index.ts';
import { API_SCOPES, DEFAULT_API_SCOPES, LEGACY_API_SCOPES, type ApiScope } from '../../packages/contracts/access.ts';

export function initializeApiAccess(db: DatabaseSync) {
  const columns = db.prepare('PRAGMA table_info(api_tokens)').all() as { name: string }[];
  if (!columns.some(column => column.name === 'scopes')) db.exec('ALTER TABLE api_tokens ADD COLUMN scopes TEXT');
  if (!columns.some(column => column.name === 'expires_at')) db.exec('ALTER TABLE api_tokens ADD COLUMN expires_at TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS api_image_requests (user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(user_id,key));
    CREATE TABLE IF NOT EXISTS api_input_requests (user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, hash TEXT NOT NULL, input_id TEXT NOT NULL, PRIMARY KEY(user_id,key));
    CREATE TABLE IF NOT EXISTS api_downloads (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), job_id TEXT NOT NULL, output_id TEXT NOT NULL, format TEXT NOT NULL, compression INTEGER, expires_at INTEGER NOT NULL);`);
}

export function savedTokenScopes(value: string | null): ApiScope[] {
  if (value === null) return [...LEGACY_API_SCOPES];
  try {
    const scopes: unknown = JSON.parse(value);
    return Array.isArray(scopes) && scopes.every(scope => API_SCOPES.includes(scope)) ? [...new Set(scopes)] : [];
  } catch { return []; }
}

export function tokenOptions(body: Record<string, unknown>): { scopes: ApiScope[]; expiresAt: string | null } {
  if (Object.keys(body).some(key => !['name', 'scopes', 'expiresInDays'].includes(key))) throw new ApiError(400, 'INVALID_TOKEN', 'Supply a name, permissions and expiration for this token.');
  const scopes = body.scopes === undefined ? DEFAULT_API_SCOPES : body.scopes;
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > API_SCOPES.length || scopes.some(scope => !API_SCOPES.includes(scope)) || new Set(scopes).size !== scopes.length) throw new ApiError(400, 'INVALID_TOKEN_SCOPES', 'Select valid permissions for this token.');
  const days = body.expiresInDays === undefined ? 90 : body.expiresInDays;
  if (days !== null && ![7, 30, 90, 365].includes(days as number)) throw new ApiError(400, 'INVALID_TOKEN_EXPIRATION', 'Choose 7, 30, 90 or 365 days, or no expiration.');
  return { scopes: [...scopes], expiresAt: days === null ? null : new Date(Date.now() + (days as number) * 86_400_000).toISOString() };
}

/** Browser routes retain their role checks. These grants constrain every token entry point. */
export function httpScopes(path: string, method: string): ApiScope[] {
  if (['/api/access', '/api/catalog', '/api/generation-tools', '/api/upscalers'].includes(path) || path === '/api/background-removal' && method === 'GET') return ['models:read'];
  if (path === '/api/state') return ['jobs:read', 'system:read'];
  if (path === '/api/work-time') return ['system:read'];
  if (path === '/api/prompts/refine') return ['text:generate'];
  if (path === '/api/jobs') return [method === 'GET' ? 'jobs:read' : 'jobs:write'];
  if (['/api/upscale', '/api/background-removal'].includes(path)) return ['jobs:write', 'assets:read'];
  if (/^\/api\/jobs\/[^/]+\/cancel$/.test(path)) return ['jobs:cancel'];
  if (/^\/api\/jobs\/[^/]+$/.test(path)) return ['jobs:read'];
  if (path === '/api/favorites') return ['jobs:read', 'assets:read'];
  if (/^\/api\/jobs\/[^/]+\/outputs\/[^/]+\/favorite$/.test(path)) return ['assets:write'];
  if (/^\/api\/jobs\/[^/]+\/outputs\/[^/]+$/.test(path)) return [method === 'DELETE' ? 'assets:delete' : 'assets:read'];
  if (path === '/api/inputs/from-output') return ['assets:read', 'assets:write'];
  if (path === '/api/inputs' || /^\/api\/inputs\/[^/]+$/.test(path)) return [method === 'GET' ? 'assets:read' : method === 'DELETE' ? 'assets:delete' : 'assets:write'];
  return [];
}
