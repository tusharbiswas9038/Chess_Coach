// Chess Coach service worker.
//
// Three-tier caching strategy:
//   1. App shell (HTML/CSS/JS): stale-while-revalidate so updates land
//      without forcing a reload, but the shell loads instantly when offline.
//   2. Fonts (Manrope from fonts.gstatic.com): cache-first, long-lived.
//      Web fonts rarely change and gating on the network costs perceivable
//      paint time on flaky connections.
//   3. API calls: network-only by default. Drill queue (/api/drills/due) is
//      explicitly cached so today's queue is offline-readable.
//
// Bumping CACHE_VERSION invalidates the shell cache on the next sw boot.

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `cc-shell-${CACHE_VERSION}`;
const FONT_CACHE = `cc-fonts-${CACHE_VERSION}`;
const API_CACHE = `cc-api-${CACHE_VERSION}`;

// Files cached on install. Kept minimal — view templates and module JS are
// fetched lazily and picked up by the runtime stale-while-revalidate.
const SHELL_PRECACHE = [
  '/',
  '/dashboard',
  '/static/index.html',
  '/static/css/tailwind.css',
  '/static/css/app.css',
  '/static/js/app.js',
  '/static/favicon.ico',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_PRECACHE).catch(() => {
        // If any single resource 404s during precache, don't abort the
        // whole install — runtime caching will pick it up.
      }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('cc-') && !k.endsWith(`-${CACHE_VERSION}`))
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isShellRequest(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/')) return false;
  // Same-origin GET that isn't an API call: SPA shell, static asset, view template.
  return true;
}

function isFontRequest(url) {
  return url.hostname === 'fonts.gstatic.com' || url.hostname === 'fonts.googleapis.com';
}

function isCacheableApi(url) {
  // Drill queue is the one API we want offline-readable. Everything else is
  // either mutation or context-sensitive; falling back to a stale snapshot
  // would be misleading.
  if (url.origin !== self.location.origin) return false;
  return url.pathname.startsWith('/api/drills/due');
}

async function staleWhileRevalidate(event, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(event.request);
  const networkPromise = fetch(event.request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(event.request, response.clone());
      }
      return response;
    })
    .catch(() => cached);
  return cached || networkPromise;
}

async function cacheFirst(event, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(event.request);
  if (cached) return cached;
  const response = await fetch(event.request);
  if (response && response.ok) {
    cache.put(event.request, response.clone());
  }
  return response;
}

async function networkFirstApi(event) {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await fetch(event.request);
    if (response && response.ok && isCacheableApi(new URL(event.request.url))) {
      cache.put(event.request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(event.request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  if (isFontRequest(url)) {
    event.respondWith(cacheFirst(event, FONT_CACHE));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    if (isCacheableApi(url)) {
      event.respondWith(networkFirstApi(event));
    }
    // Other API calls fall through to the network — sw doesn't intercept.
    return;
  }

  if (isShellRequest(url)) {
    event.respondWith(staleWhileRevalidate(event, SHELL_CACHE));
  }
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
