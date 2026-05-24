// Service worker for the GSO Thrive Program PWA.
//
// Strategy: network-first for navigations and same-origin static assets, with a
// minimal offline fallback. Firebase Auth, Firestore, and Cloud Functions
// traffic is intentionally NOT cached — the app must always talk to the live
// backend for auth state and writes. Bump SW_VERSION any time we want every
// installed client to fetch fresh assets after the next visit.

const SW_VERSION = 'gso-thrive-20260524-1700-7822d37';
const STATIC_CACHE = `static-${SW_VERSION}`;
const OFFLINE_URL = '/offline.html';

// Files we want available offline so the app can at least render an "offline"
// state instead of the browser's dinosaur. Keep this list short — it's
// precached on install.
const PRECACHE_URLS = [
  '/offline.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Skip caching for cross-origin requests (Firebase services, Google APIs, CDNs).
function isSameOrigin(url) {
  try { return new URL(url).origin === self.location.origin; }
  catch { return false; }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Navigation requests: try network, fall back to cached offline page.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match(OFFLINE_URL))
    );
    return;
  }

  // Scripts: do NOT intercept. After the Phase 2.1 split into many small
  // ES modules, SW-side caching of scripts caused stale-module bugs that
  // outlived SW_VERSION bumps (the browser's module map locked in the
  // SW's stale response). Cache-Control: no-cache headers on **/*.js
  // (firebase.json) handle caching correctly at the HTTP layer — let the
  // browser do it natively.
  if (req.destination === 'script') return;

  // Same-origin non-script GETs (style/image/font/etc.): network-first,
  // fall back to cache (for offline reloads after the user has already
  // loaded the app once).
  if (isSameOrigin(req.url)) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok && (req.destination === 'style' ||
                       req.destination === 'image' || req.destination === 'font')) {
          const clone = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(req, clone)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req))
    );
  }
  // Cross-origin: let the browser handle it (don't intercept Firebase calls).
});
