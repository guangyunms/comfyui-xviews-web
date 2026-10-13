/* Only the viewer's own program files are cached. A selected media.db never
 * becomes an HTTP request and is stored separately in this device's OPFS. */
const CACHE_PREFIX = 'comfyxviews-ipad-shell-';
const CACHE_NAME = CACHE_PREFIX + 'v1';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './db-worker.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png',
  './icons/icon-512.png', './icons/apple-touch-icon.png',
  './vendor/sqlite3.mjs', './vendor/sqlite3.wasm',
];
const assetURLs = new Set(ASSETS.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(ASSETS.map(path => new Request(
      new URL(path, self.registration.scope), { cache: 'reload' },
    )));
    await self.skipWaiting();
  })());
});

async function announceReady(target) {
  const message = { type: 'OFFLINE_READY', version: CACHE_NAME };
  if (target) target.postMessage(message);
  else for (const client of await self.clients.matchAll({ type: 'window' })) {
    client.postMessage(message);
  }
}

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
    await announceReady();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'CHECK_OFFLINE') event.waitUntil(announceReady(event.source));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  url.search = '';
  url.hash = '';
  if (!assetURLs.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(url.href);
    if (cached) return cached;
    // An interrupted first installation must report failure rather than
    // claiming that the offline program is available.
    return fetch(request);
  })());
});
