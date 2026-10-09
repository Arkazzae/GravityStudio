import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { createPwaWorker } from '../../apps/studio/src/lib/pwa-worker.ts';
import { GET as manifest } from '../../apps/studio/src/app/manifest.webmanifest/route.ts';

const origin = 'https://studio.test';
const absolute = (input: string | { url: string }) => new URL(typeof input === 'string' ? input : input.url, origin).href;
class MemoryCache {
  entries = new Map<string, Response>();
  async put(request: string | { url: string }, response: Response) { this.entries.set(absolute(request), response.clone()); }
  async match(request: string | { url: string }) { return this.entries.get(absolute(request))?.clone(); }
  async keys() { return [...this.entries.keys()].map(url => new Request(url)); }
  async delete(request: string | { url: string }) { return this.entries.delete(absolute(request)); }
  async addAll(urls: string[]) { for (const url of urls) await this.put(url, new Response('public offline shell')); }
}
function storage() {
  const entries = new Map<string, MemoryCache>();
  return {
    async keys() { return [...entries.keys()]; },
    async open(name: string) { if (!entries.has(name)) entries.set(name, new MemoryCache()); return entries.get(name)!; },
    async delete(name: string) { return entries.delete(name); },
  };
}
function worker(cacheStorage = storage(), revision = 'build-one') {
  const handlers: Record<string, (event: any) => void> = {};
  const state = {
    offline: false, badShell: false, status: 200, type: 'application/javascript', body: 'public chunk', cacheControl: 'public, immutable',
    calls: [] as string[], skipped: 0, claimed: 0, opened: [] as string[], focused: [] as string[],
    windows: [] as { url: string; focus: () => Promise<void> }[],
  };
  vm.runInNewContext(createPwaWorker(revision), {
    caches: cacheStorage, URL, Request, Response, Headers, Promise,
    self: {
      location: { origin }, addEventListener: (type: string, handler: (event: any) => void) => { handlers[type] = handler; },
      skipWaiting: async () => { state.skipped++; },
      clients: { claim: async () => { state.claimed++; }, matchAll: async () => state.windows, openWindow: async (url: string) => { state.opened.push(url); } },
    },
    fetch: async (input: string | { url: string }) => {
      state.calls.push(absolute(input));
      if (state.offline) throw new TypeError('Offline');
      if (absolute(input).endsWith('/offline.html')) return new Response(state.badShell ? '<html>Sign in to your account</html>' : '<html data-gravity-offline="1">public offline shell</html>', { headers: { 'Content-Type': 'text/html' } });
      if (absolute(input).includes('/pwa/')) return new Response('public icon', { headers: { 'Content-Type': 'image/png' } });
      return new Response(state.body, { status: state.status, headers: { 'Content-Type': state.type, 'Cache-Control': state.cacheControl } });
    },
  });
  async function event(type: string, options: Record<string, unknown> = {}) {
    const waits: Promise<unknown>[] = [];
    handlers[type]({ ...options, waitUntil: (task: Promise<unknown>) => waits.push(task) });
    await Promise.all(waits);
  }
  return {
    state, caches: cacheStorage, event,
    async dispatch(path: string, { method = 'GET', mode = 'cors', destination = 'script', headers = {} } = {}) {
      let response: Promise<Response> | undefined;
      const waits: Promise<unknown>[] = [];
      handlers.fetch({ request: { url: new URL(path, origin).href, method, mode, destination, headers: new Headers(headers) },
        respondWith: (result: Promise<Response>) => { response = result; }, waitUntil: (task: Promise<unknown>) => waits.push(task),
      });
      const result = await response;
      await Promise.all(waits);
      return result;
    },
  };
}

test('PWA manifest preserves brand and only advertises existing routes', async () => {
  const response = manifest();
  assert.match(response.headers.get('content-type')!, /application\/manifest\+json/);
  const result = await response.json();
  assert.equal(result.name, 'Gravity Studio');
  assert.equal(result.start_url, '/image');
  assert.equal(result.scope, '/');
  assert.equal(result.display, 'standalone');
  assert.deepEqual(result.shortcuts.map((shortcut: { url: string }) => shortcut.url), ['/image']);
  assert.ok(result.icons.some((icon: { purpose: string }) => icon.purpose === 'maskable'));
});

test('worker revisions change the script and reject code injection', () => {
  assert.notEqual(createPwaWorker('revision-one'), createPwaWorker('revision-two'));
  assert.doesNotMatch(createPwaWorker('revision-one'), /__GRAVITY_BUILD_ID__/);
  assert.throws(() => createPwaWorker("';evil()"), /Invalid/);
});

test('install precaches a public fallback and waits for explicit update activation', async () => {
  const app = worker();
  await app.event('install');
  assert.equal(app.state.skipped, 0);
  await app.event('message', { data: { type: 'gravity:activate-update' }, source: { url: 'https://other.test/image' } });
  assert.equal(app.state.skipped, 0);
  await app.event('message', { data: { type: 'gravity:activate-update' }, source: { url: `${origin}/image` } });
  assert.equal(app.state.skipped, 1);
  app.state.offline = true;
  assert.equal(await (await app.dispatch('/image', { mode: 'navigate', destination: 'document' }))!.text(), '<html data-gravity-offline="1">public offline shell</html>');
  assert.equal(await (await app.dispatch('/pwa/icon-192.png', { destination: 'image' }))!.text(), 'public icon');
});

test('API, authenticated assets, RSC, external and ranged requests never enter worker caches', async () => {
  const app = worker();
  for (const path of ['/api', '/api/auth/session', '/api/jobs/job/outputs/image.png', '/api/text/local', '/api/events', '/image?_rsc=123', '/assets/generated.png', 'https://cdn.test/image.png']) {
    assert.equal(await app.dispatch(path), undefined, path);
  }
  assert.equal(await app.dispatch('/api/auth/session', { mode: 'navigate' }), undefined);
  assert.equal(await app.dispatch('/image', { headers: { RSC: '1' } }), undefined);
  assert.equal(await app.dispatch('/_next/static/chunk.js', { headers: { Range: 'bytes=0-1' } }), undefined);
  assert.equal(await app.dispatch('/_next/static/chunk.js', { method: 'POST' }), undefined);
  assert.deepEqual(await app.caches.keys(), []);
  assert.deepEqual(app.state.calls, []);
});

test('install never stores an authentication wall in place of the public offline page', async () => {
  const app = worker(); app.state.badShell = true;
  await assert.rejects(app.event('install'), /public offline shell is unavailable/);
  assert.equal(await (await app.caches.open('gravity-studio-pwa-build-one-shell')).match('/offline.html'), undefined);
  assert.equal(app.state.skipped, 0);
});

test('online HTML including login and private pages is never cached or replayed offline', async () => {
  const app = worker();
  await app.event('install');
  app.state.type = 'text/html'; app.state.body = 'private account markup';
  for (const path of ['/image', '/login']) {
    assert.equal(await (await app.dispatch(path, { mode: 'navigate', destination: 'document' }))!.text(), 'private account markup');
  }
  app.state.offline = true;
  assert.equal(await (await app.dispatch('/login', { mode: 'navigate', destination: 'document' }))!.text(), '<html data-gravity-offline="1">public offline shell</html>');
  for (const name of await app.caches.keys()) {
    const cache = await app.caches.open(name);
    assert.equal(await cache.match('/image'), undefined);
    assert.equal(await cache.match('/login'), undefined);
  }
});

test('public build chunks are cached while failed or private responses are excluded', async () => {
  const app = worker();
  await app.dispatch('/_next/static/chunk.js');
  app.state.offline = true;
  assert.equal(await (await app.dispatch('/_next/static/chunk.js'))!.text(), 'public chunk');
  assert.equal(app.state.calls.length, 1);
  app.state.offline = false;
  for (const [status, type, policy] of [[404, 'application/javascript', 'public'], [200, 'text/html', 'public'], [200, 'application/javascript', 'private'], [200, 'text/x-component', 'public'], [200, 'application/javascript', 'no-store']] as const) {
    app.state.status = status; app.state.type = type; app.state.cacheControl = policy;
    const path = `/_next/static/${status}-${type.replace('/', '-')}-${policy}.js`;
    await app.dispatch(path);
    assert.equal(await (await app.caches.open('gravity-studio-pwa-build-one-assets')).match(path), undefined);
  }
});

test('cache failures keep online build files available and offline navigation fails safely', async () => {
  const broken = storage(); broken.open = async () => { throw new Error('Storage disabled'); };
  const app = worker(broken);
  assert.equal(await (await app.dispatch('/_next/static/chunk.js'))!.text(), 'public chunk');
  app.state.offline = true;
  assert.equal((await app.dispatch('/image', { mode: 'navigate' }))!.type, 'error');
});

test('activation retains previous build chunks and removes only owned obsolete caches', async () => {
  const app = worker();
  await (await app.caches.open('unrelated-app')).put('/unrelated.js', new Response('unrelated'));
  await (await app.caches.open('gravity-studio-pwa-ancient-assets')).put('/_next/static/ancient.js', new Response('ancient'));
  await (await app.caches.open('gravity-studio-pwa-previous-assets')).put('/_next/static/open-tab.js', new Response('previous build'));
  await (await app.caches.open('gravity-pwa-v6-images-user-one')).put('/api/inputs/old.png', new Response('private old bytes'));
  await app.event('install'); await app.event('activate');
  assert.deepEqual(await app.caches.keys(), ['unrelated-app', 'gravity-studio-pwa-previous-assets', 'gravity-studio-pwa-build-one-shell']);
  assert.equal(app.state.claimed, 1);
  app.state.offline = true;
  assert.equal(await (await app.dispatch('/_next/static/open-tab.js'))!.text(), 'previous build');
});

test('public build cache has an entry limit and oversized responses do not enter it', async () => {
  const app = worker();
  for (let i = 0; i < 132; i++) await app.dispatch(`/_next/static/chunk-${i}.js`);
  const cache = await app.caches.open('gravity-studio-pwa-build-one-assets');
  assert.equal((await cache.keys()).length, 128);
  assert.equal(await cache.match('/_next/static/chunk-0.js'), undefined);
  app.state.body = 'x'.repeat(8 * 1024 * 1024 + 1);
  await app.dispatch('/_next/static/oversized.js');
  assert.equal(await cache.match('/_next/static/oversized.js'), undefined);
});

test('notification clicks focus an existing studio or open only the fixed studio route', async () => {
  const app = worker();
  let closed = 0;
  const click = (url: string) => app.event('notificationclick', { notification: { data: { url }, close: () => { closed++; } } });
  for (const url of ['https://external.test/image', '/api/secret', '/image?redirect=external', '/image#fragment', '//evil.test/image']) await click(url);
  assert.equal(closed, 5);
  assert.deepEqual(app.state.opened, []);
  await click('/image');
  assert.deepEqual(app.state.opened, ['/image']);
  app.state.windows.push({ url: `${origin}/image`, focus: async () => { app.state.focused.push('/image'); } });
  await click('/image');
  assert.deepEqual(app.state.focused, ['/image']);
  assert.deepEqual(app.state.opened, ['/image']);
});
