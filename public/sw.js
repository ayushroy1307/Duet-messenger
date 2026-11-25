// Duet service worker: offline shell + opaque push notifications.
// It never caches /api/* (ciphertext and session state stay out of Cache Storage).
const BUILD = '__BUILD__';
const CACHE = 'duet-shell-' + BUILD;
const SHELL = ['/', '/styles.css', '/manifest.webmanifest', '/favicon.ico',
  '/js/theme.js', '/js/build.js', '/js/app.js', '/js/main.js', '/js/state.js', '/js/ui.js', '/js/store.js', '/js/settings.js',
  '/js/bio.js', '/js/media.js', '/js/voice.js', '/img/chat-bg.jpg', '/js/countries.js', '/js/api.js', '/js/engine.js', '/js/crypto.js', '/js/vaultcore.js', '/js/util.js',
  '/img/chat-bg.jpg', '/icons/icon-32.png', '/icons/icon-64.png', '/icons/icon-128.png', '/icons/icon-256.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' }))))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('duet-shell-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const isNav = req.mode === 'navigate';
  e.respondWith((async () => {
    try {
      const res = await fetch(req); // network first so a new build is picked up immediately
      if (res.ok) { const c = await caches.open(CACHE); c.put(isNav ? '/' : req, res.clone()); }
      return res;
    } catch {
      const c = await caches.open(CACHE);
      return (await c.match(isNav ? '/' : req)) || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
    }
  })());
});

// Push payloads are empty by design: the push service learns only that "something happened".
self.addEventListener('push', (e) => {
  e.waitUntil(self.registration.showNotification('Duet', { body: 'You have a new message', icon: '/icons/icon-192.png', badge: '/icons/icon-96.png', tag: 'duet-message', renotify: true }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('/');
  })());
});
