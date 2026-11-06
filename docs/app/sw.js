// Caches the app shell, the database engine and the migrations on first visit,
// so the app opens with no signal afterwards. The data itself lives in the
// browser's IndexedDB through the database, not in this cache.
const CACHE = 'stable-app-v2';
const SHELL = ['./', './index.html', './app.css', './app.js', './manifest.webmanifest', './icon.svg', '../sql/index.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok && (url.pathname.includes('/vendor/') || url.pathname.includes('/sql/') || url.pathname.includes('/app/'))) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    })),
  );
});
