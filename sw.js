// BERSERKERMOD — Service Worker
// Caches the app shell so the PWA opens offline. API calls are never cached
// so live sync / coach data stay fresh.

const CACHE = 'berserkermod-v2-0';
// Paths are relative to the SW's scope so the same shell list works both on
// local serve.ps1 (root scope) and on GitHub Pages subpath (/berserkermod/).
const SHELL = [
    './',
    './index.html',
    './BERSERKERMOD.html',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then((cache) => cache.addAll(SHELL).catch(() => {/* best-effort */}))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;

    // Only handle GET requests; everything else (POST to /api/health-data,
    // /api/routines, etc.) goes straight to network.
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Never cache the API surface — coach data + health sync must be live.
    if (url.pathname.startsWith('/api/')) return;

    // Network-first for HTML so the user always gets the latest version
    // when online; falls back to cache (or app shell) when offline.
    const isHtml = req.headers.get('accept')?.includes('text/html');

    if (isHtml) {
        event.respondWith(
            fetch(req)
                .then((res) => {
                    if (res.ok && url.origin === location.origin) {
                        const clone = res.clone();
                        caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
                    }
                    return res;
                })
                .catch(() => caches.match(req).then((r) => r || caches.match('./BERSERKERMOD.html') || caches.match('./index.html')))
        );
        return;
    }

    // Cache-first for everything else (fonts, JSON, icons, etc.)
    event.respondWith(
        caches.match(req).then((cached) => {
            if (cached) return cached;
            return fetch(req).then((res) => {
                if (res.ok && url.origin === location.origin) {
                    const clone = res.clone();
                    caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
                }
                return res;
            }).catch(() => cached);
        })
    );
});
