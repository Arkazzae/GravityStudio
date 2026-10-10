import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { Store } from '../../apps/server/store.ts';
import { createSession, digest } from '../../apps/server/auth.ts';
import { createStudioServer } from '../../apps/server/http.ts';
import { API_SCOPES, DEFAULT_API_SCOPES, LEGACY_API_SCOPES, type ApiToken } from '../../packages/contracts/access.ts';
import { engineFixture } from './helpers/engine-fixture.ts';

const origin = 'https://studio.example.test';
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const f = await engineFixture();
  const server = await createStudioServer({ store: f.store, engine: f.engine, allowedOrigins: [origin], setupSecret: 'access-fixture' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await server.closeOperations(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = createSession(f.store, f.owner, false).split(';')[0];
  async function request(path: string, method = 'GET', body?: unknown, token?: string, headers: Record<string, string> = {}) {
    return fetch(`${url}${path}`, { method, headers: { ...(token === undefined ? { Cookie: cookie, Origin: origin } : { Authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function issue(body: Record<string, unknown>): Promise<ApiToken & { token: string }> {
    const response = await request('/api/tokens', 'POST', body); assert.equal(response.status, 201); return response.json();
  }
  return { ...f, request, issue, url, cookie };
}

test('token creation records explicit scopes and expiry, hashes secrets, and exposes only personal metadata', async t => {
  const f = await fixture(t);
  const before = Date.now();
  const created = await f.issue({ name: 'Library reader', scopes: ['models:read', 'assets:read'], expiresInDays: 7 });
  assert.deepEqual(created.scopes, ['models:read', 'assets:read']);
  assert.match(created.token, /^gs_/);
  assert.equal(created.lastUsedAt, null);
  assert(Date.parse(created.expiresAt!) >= before + 7 * 86400000 && Date.parse(created.expiresAt!) <= Date.now() + 7 * 86400000);
  const row = f.store.db.prepare('SELECT * FROM api_tokens WHERE id=?').get(created.id)!;
  assert.equal(row.hash, digest(created.token));
  assert.equal(JSON.stringify(row).includes(created.token), false, 'Only the digest is persisted');
  const listed = await (await f.request('/api/tokens')).json() as { tokens: ApiToken[] };
  assert.equal(listed.tokens.length, 1);
  assert.deepEqual(listed.tokens[0], { id: created.id, name: created.name, createdAt: created.createdAt, lastUsedAt: null, expiresAt: created.expiresAt, scopes: created.scopes });
  assert.equal((await f.request('/api/catalog', 'GET', undefined, created.token)).status, 200);
  assert.ok(f.store.apiTokens(f.owner.id)[0].lastUsedAt, 'Authenticated token usage updates its timestamp');
  assert.equal((await f.request('/api/jobs', 'GET', undefined, created.token)).status, 403);
  assert.equal((await f.request('/api/tokens', 'GET', undefined, created.token)).status, 403, 'A token cannot inspect or mint credentials');
  assert.equal((await f.request('/api/tokens', 'POST', { name: 'Privilege escalation', scopes: [...API_SCOPES] }, created.token)).status, 403);
  const assetsOnly = await f.issue({ name: 'Asset downloads', scopes: ['assets:read'], expiresInDays: 7 });
  assert.equal((await f.request('/api/access', 'GET', undefined, assetsOnly.token)).status, 403, 'Discovery cannot bypass model permissions');
});

test('scope denials happen before mutations and full-workflow tokens cannot administer Studio', async t => {
  const f = await fixture(t);
  const read = await f.issue({ name: 'Read only', scopes: ['models:read', 'jobs:read', 'assets:read'], expiresInDays: 30 });
  for (const [path, method, body] of [
    ['/api/jobs', 'POST', { modelId: 'sdxl-base', prompt: 'Must not queue' }],
    ['/api/jobs/unknown/cancel', 'POST', {}],
    ['/api/inputs', 'POST', {}],
    ['/api/inputs/unknown', 'DELETE', undefined],
    ['/api/jobs/unknown/outputs/0', 'DELETE', undefined],
    ['/api/jobs/unknown/outputs/0/favorite', 'PUT', { favorite: true }],
    ['/api/upscale', 'POST', {}],
    ['/api/background-removal', 'POST', {}],
    ['/api/prompts/refine', 'POST', {}],
  ] as const) assert.equal((await f.request(path, method, body, read.token)).status, 403, `${method} ${path} checks the token before processing`);
  const writeOnly = await f.issue({ name: 'Generate without library access', scopes: ['jobs:write'], expiresInDays: 7 });
  const inputId = 'ab790e75-4273-4c56-8565-ab1b677c2b4b';
  for (const [path, body] of [
    ['/api/upscale', { modelId: 'nomos2', source: { type: 'input', inputId }, scale: 2 }],
    ['/api/background-removal', { source: { type: 'input', inputId } }],
    ['/api/jobs', { modelId: 'sdxl-base', prompt: 'Edit a saved reference', images: [inputId] }],
    ['/api/jobs', { modelId: 'sdxl-base', prompt: 'Use a saved mask', maskId: inputId }],
  ] as const) {
    const response = await f.request(path, 'POST', body, writeOnly.token, { 'Idempotency-Key': 'scope-denial-before-source-lookup' });
    assert.equal(response.status, 403, `${path} cannot use saved assets with jobs:write alone`);
    const denied = await response.json();
    assert.equal(denied.error.code, 'INSUFFICIENT_SCOPE');
    assert.match(denied.error.message, /assets:read/);
  }
  assert.equal(f.store.jobs().length, 0); assert.equal(f.store.inputs(f.owner.id).length, 0);
  const full = await f.issue({ name: 'Studio workflows', scopes: [...API_SCOPES], expiresInDays: null });
  assert.equal(full.expiresAt, null);
  for (const [path, method, body] of [
    ['/api/settings', 'GET', undefined], ['/api/settings', 'PUT', {}], ['/api/runtime', 'POST', {}],
    ['/api/models/download', 'POST', {}], ['/api/admin/users', 'GET', undefined], ['/api/integrations', 'GET', undefined],
    ['/api/text/connection', 'PUT', {}], ['/api/text/assistant', 'PUT', {}],
  ] as const) assert.equal((await f.request(path, method, body, full.token)).status, 403, `${method} ${path} retains session and administrator checks`);
  const discovery = await f.request('/api/access'); assert.equal(discovery.status, 200);
  const data = await discovery.json();
  assert.deepEqual(data.endpoints, { mcp: '/api/mcp', openai: '/v1', rest: '/api' });
  assert.deepEqual(data.scopes, [...API_SCOPES]);
  assert(Array.isArray(data.models.images)); assert(Array.isArray(data.models.text));
});

test('new default tokens expire and never gain paid text access; invalid grants cannot be issued', async t => {
  const f = await fixture(t);
  const created = await f.issue({ name: 'Default client' });
  assert.deepEqual(created.scopes, [...DEFAULT_API_SCOPES]);
  assert.equal(created.scopes.includes('text:generate'), false);
  assert(Date.parse(created.expiresAt!) - Date.now() > 89.99 * 86400000);
  for (const body of [
    { scopes: [] }, { scopes: null }, { scopes: ['admin'] }, { scopes: ['jobs:read', 'jobs:read'] },
    { scopes: 'jobs:read' }, { expiresInDays: 1 }, { expiresInDays: '7' }, { expiresInDays: 0 },
    { scopes: ['models:read'], unrecognized: true },
  ]) assert.equal((await f.request('/api/tokens', 'POST', { name: 'Invalid permissions', ...body })).status, 400, JSON.stringify(body));
  assert.equal(f.store.apiTokens(f.owner.id).length, 1);
  const expired = await f.issue({ name: 'Expired client', scopes: ['models:read'], expiresInDays: 7 });
  f.store.db.prepare('UPDATE api_tokens SET expires_at=? WHERE id=?').run(new Date(0).toISOString(), expired.id);
  assert.equal((await f.request('/api/catalog', 'GET', undefined, expired.token)).status, 401);
  assert.equal(f.store.apiTokens(f.owner.id).find(token => token.id === expired.id)?.lastUsedAt, null);
  assert.equal((await f.request(`/api/tokens/${created.id}`, 'DELETE')).status, 200);
  assert.equal((await f.request('/api/catalog', 'GET', undefined, created.token)).status, 401);
});

test('legacy token migration preserves existing image grants without silently enabling language model billing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gravity-legacy-access-'));
  const db = new DatabaseSync(join(directory, 'studio.sqlite'));
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE,password TEXT,created_at TEXT); CREATE TABLE api_tokens(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,last_used_at TEXT);');
  db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('owner', 'legacy-owner', 'password-hash', '2020-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO api_tokens VALUES(?,?,?,?,?,?)').run('legacy-key', 'owner', 'Legacy client', digest('legacy-secret'), '2020-01-01T00:00:00.000Z', null); db.close();
  let store = new Store(directory);
  try {
    const migrated = store.apiTokenAccess(digest('legacy-secret'))!;
    assert.equal(migrated.user.id, 'owner'); assert.deepEqual(migrated.scopes, [...LEGACY_API_SCOPES]);
    assert.equal(migrated.scopes.includes('text:generate'), false);
    assert.equal(store.apiTokens('owner')[0].expiresAt, null);
    store.close(); store = new Store(directory);
    assert.deepEqual(store.apiTokenAccess(digest('legacy-secret'))!.scopes, [...LEGACY_API_SCOPES]);
    store.db.prepare('UPDATE api_tokens SET scopes=? WHERE id=?').run('malformed', 'legacy-key');
    assert.deepEqual(store.apiTokenAccess(digest('legacy-secret'))!.scopes, [], 'Unreadable grants fail closed instead of inheriting legacy access');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
