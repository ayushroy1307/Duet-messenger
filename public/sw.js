/* Duet service worker — offline shell, static cache, opaque push. */

const VERSION = 'duet-2026-11-19.1';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/app.css',
  '/icons/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-180.png',
  '/js/app.js',
  '/js/api.js',
  '/js/crypto.js',
  '/js/db.js',
  '/js/diag.js',
  '/js/engine.js',
  '/js/icons.js',
  '/js/media.js',
  '/js/preact.js',
  '/js/push.js',
  '/js/settings.js',
  '/js/sheets.js',
  '/js/store.js',
  '/js/ui.js',
  '/js/util.js',
  '/js/vault.js',
  '/js/screens/auth.js',
  '/js/screens/chat.js',
  '/js/screens/home.js',
  '/vendor/preact/preact.module.js',
  '/vendor/preact/hooks.module.js',
  '/vendor/noble/ciphers/_arx.js',
  '/vendor/noble/ciphers/_assert.js',
  '/vendor/noble/ciphers/_micro.js',
  '/vendor/noble/ciphers/_poly1305.js',
  '/vendor/noble/ciphers/_polyval.js',
  '/vendor/noble/ciphers/chacha.js',
  '/vendor/noble/ciphers/crypto.js',
  '/vendor/noble/ciphers/utils.js',
  '/vendor/noble/ciphers/webcrypto.js',
  '/vendor/noble/curves/_shortw_utils.js',
  '/vendor/noble/curves/abstract/curve.js',
  '/vendor/noble/curves/abstract/edwards.js',
  '/vendor/noble/curves/abstract/hash-to-curve.js',
  '/vendor/noble/curves/abstract/modular.js',
  '/vendor/noble/curves/abstract/montgomery.js',
  '/vendor/noble/curves/abstract/poseidon.js',
  '/vendor/noble/curves/abstract/utils.js',
  '/vendor/noble/curves/abstract/weierstrass.js',
  '/vendor/noble/curves/ed25519.js',
  '/vendor/noble/curves/utils.js',
  '/vendor/noble/hashes/_assert.js',
  '/vendor/noble/hashes/_blake.js',
  '/vendor/noble/hashes/_md.js',
  '/vendor/noble/hashes/_u64.js',
  '/vendor/noble/hashes/crypto.js',
  '/vendor/noble/hashes/hkdf.js',
  '/vendor/noble/hashes/hmac.js',
  '/vendor/noble/hashes/scrypt.js',
  '/vendor/noble/hashes/pbkdf2.js',
  '/vendor/noble/hashes/sha2.js',
  '/vendor/noble/hashes/utils.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll is all-or-nothing; add individually so one stale path cannot
    // poison an otherwise valid install.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never cache ciphertext or auth
  if (url.pathname === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  // App code (js/css/html) is network-first so a new deploy takes effect on the
  // very next load. Stale-while-revalidate kept running the OLD code once.
  // Vendor libraries are versioned and immutable, so a cache hit is fine.
  if (url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    if (response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    const shell = await caches.open(SHELL_CACHE);
    const fallback = await shell.match(request);
    if (fallback) return fallback;
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put('/index.html', response.clone());
    return response;
  } catch {
    const cached = await cache.match('/index.html') || await cache.match('/');
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Duet offline</title><body style="font-family:sans-serif;padding:2rem"><h1>Duet is offline</h1><p>Reconnect to open your vault. Messages already decrypted may still be available once the app loads.</p></body>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  }).catch(() => null);
  if (cached) return cached;
  const response = await network;
  if (response) return response;
  const shell = await caches.open(SHELL_CACHE);
  const fallback = await shell.match(request);
  if (fallback) return fallback;
  return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}

/* -------------------------------------------------------------------------- */
/* Push                                                                       */
/* -------------------------------------------------------------------------- */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json?.() || {};
  } catch {
    data = {};
  }
  // Never take notification text from the payload beyond the generic defaults.
  const title = 'Duet';
  const body = 'New message';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: 'duet-message',
    renotify: true,
    data: { t: data.t || 'm' },
    silent: false
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        try {
          await client.focus();
          client.postMessage({ type: 'duet:push-open' });
          return;
        } catch { /* try the next window */ }
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow('/');
    }
  })());
});
