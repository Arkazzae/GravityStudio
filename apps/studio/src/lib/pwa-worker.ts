// Served by /sw.js with the same revision as the production Next.js build.
// Keep this source independent of bundler globals: it runs in a service worker.
export const pwaWorkerSource = String.raw`
const PREFIX = 'gravity-studio-pwa-';
const REVISION = '__GRAVITY_BUILD_ID__';
const SHELL = PREFIX + REVISION + '-shell';
const ASSETS = PREFIX + REVISION + '-assets';
const OFFLINE = '/offline.html';
const PUBLIC_FILES = [OFFLINE, '/pwa/icon-192.png', '/pwa/icon-512.png', '/pwa/icon-maskable-512.png', '/pwa/apple-touch-icon.png'];
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
let pendingWrites = 0;
let writes = Promise.resolve();

self.addEventListener('install', event => {
  // A replacement waits until the person chooses Reload or closes every tab.
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    for (const path of PUBLIC_FILES) {
      const response = await fetch(path, { cache: 'reload' });
      const type = response.headers.get('content-type') || '';
      if (response.status !== 200 || response.redirected ||
          (path === OFFLINE ? !type.startsWith('text/html') || !(await response.clone().text()).includes('data-gravity-offline="1"') : !type.startsWith('image/png'))) {
        throw new Error('The public offline shell is unavailable');
      }
      await cache.put(path, response);
    }
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    const previous = names.filter(name => name.startsWith(PREFIX) && name.endsWith('-assets') && name !== ASSETS).at(-1);
    await Promise.all(names.filter(name => name.startsWith('gravity-pwa-') ||
      (name.startsWith(PREFIX) && name !== SHELL && name !== ASSETS && name !== previous)).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'gravity:activate-update' && event.source?.url && new URL(event.source.url).origin === self.location.origin) {
    event.waitUntil(self.skipWaiting());
  }
});

// Only public build files enter this cache. Bound both disk use and queued copies.
function remember(request, response) {
  if (pendingWrites >= 4) return Promise.resolve();
  pendingWrites++;
  const copy = response.clone();
  writes = writes.catch(() => {}).then(async () => {
    if (Number(copy.headers.get('content-length')) > MAX_ASSET_BYTES) return;
    const body = await copy.blob();
    if (body.size > MAX_ASSET_BYTES) return;
    const headers = new Headers(copy.headers);
    headers.delete('content-encoding');
    headers.set('content-length', String(body.size));
    headers.set('x-gravity-cache-bytes', String(body.size));
    const cache = await caches.open(ASSETS);
    await cache.put(request, new Response(body, { status: 200, headers }));
    const keys = await cache.keys();
    let bytes = 0;
    const entries = [];
    for (const key of keys) {
      const entry = await cache.match(key);
      const size = Number(entry?.headers.get('x-gravity-cache-bytes') || 0);
      bytes += size;
      entries.push([key, size]);
      void entry?.body?.cancel().catch(() => {});
    }
    while (bytes > MAX_CACHE_BYTES || entries.length > 128) {
      const [key, size] = entries.shift();
      await cache.delete(key);
      bytes -= size;
    }
  }).catch(() => {}).finally(() => {
    pendingWrites--;
    if (!copy.bodyUsed) void copy.body?.cancel().catch(() => {});
  });
  return writes;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // API, generated assets, credentials, RSC and third-party traffic stay network-only.
  if (url.origin !== self.location.origin || request.method !== 'GET' || request.headers.has('range') ||
      url.pathname === '/api' || url.pathname.startsWith('/api/') || request.headers.has('RSC') || url.searchParams.has('_rsc')) return;
  if (PUBLIC_FILES.includes(url.pathname) && !url.search) {
    event.respondWith(caches.open(SHELL).then(cache => cache.match(request)).then(hit => hit || fetch(request)).catch(() => fetch(request)));
    return;
  }
  if (request.mode === 'navigate') {
    // Never cache a signed-in page, login response, prompt or generation.
    event.respondWith(fetch(request).catch(async () => {
      try { return (await (await caches.open(SHELL)).match(OFFLINE)) || Response.error(); }
      catch { return Response.error(); }
    }));
    return;
  }
  if (!url.pathname.startsWith('/_next/static/') || url.search || !['script', 'style', 'font'].includes(request.destination)) return;
  event.respondWith((async () => {
    try {
      const cache = await caches.open(ASSETS);
      const hit = await cache.match(request);
      if (hit) return hit;
      // An open tab may still be using the previous build after another tab updates.
      for (const name of (await caches.keys()).filter(name => name.startsWith(PREFIX) && name.endsWith('-assets') && name !== ASSETS)) {
        const previous = await (await caches.open(name)).match(request);
        if (previous) return previous;
      }
    } catch { /* A full or disabled cache must not block the online studio. */ }
    const response = await fetch(request);
    const type = response.headers.get('content-type') || '';
    if (response.status === 200 && !response.redirected && /^(?:text\/(?:css|javascript)|application\/(?:javascript|x-javascript|font-woff)|font\/)/i.test(type) &&
        !/\b(?:private|no-store)\b/i.test(response.headers.get('cache-control') || '')) event.waitUntil(remember(request, response));
    return response;
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const data = event.notification.data || {};
    // Notifications can only open the studio, never arbitrary URLs or API routes.
    if (typeof data.url === 'string') {
      try {
        const url = new URL(data.url, self.location.origin);
        if (url.origin !== self.location.origin || url.pathname !== '/image' || url.hash || url.search) return;
      } catch { return; }
    }
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const studio = clients.find(client => new URL(client.url).origin === self.location.origin && new URL(client.url).pathname === '/image');
    if (studio) {
      await studio.focus();
      return;
    }
    await self.clients.openWindow('/image');
  })());
});
`;

export function createPwaWorker(revision: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(revision)) throw new Error('Invalid PWA build revision');
  return pwaWorkerSource.replace('__GRAVITY_BUILD_ID__', revision);
}
