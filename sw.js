// BERSERKERMOD — Service Worker
// Caches the app shell so the PWA opens offline. API calls are never cached
// so live sync / coach data stay fresh.

// VERSION va también en la URL de core/calc.js en BERSERKERMOD.html (test/release.test.mjs lo chequea).
// Subirla cada vez que cambia un archivo que se sirve desde la caché (core/, íconos, fuentes,
// img/, pdfjs/, manifest.json): si no, quien ya tiene la app sigue con el viejo para siempre.
// test/release.test.mjs lo frena (guarda la huella de esos archivos en release-manifest.json).
const VERSION = '2-37';
const CACHE = 'berserkermod-v' + VERSION;
const NET_TIMEOUT_MS = 3000;   // más que esto esperando la red, y hay copia: se muestra la copia
// Paths are relative to the SW's scope so the same shell list works both on
// local serve.ps1 (root scope) and on GitHub Pages subpath (/berserkermod/).
const SHELL = [
    './',
    './index.html',
    './BERSERKERMOD.html',
    './core/calc.js?v=' + VERSION,
    './core/i18n-data.js?v=' + VERSION,
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable.png',
    './fonts/inter-latin.woff2',
    './fonts/inter-latin-ext.woff2'
];

// Si la precarga falla (mala señal), esta versión no se instala: sigue la anterior con su
// caché completa y el navegador reintenta más tarde. Antes el error se tragaba y la versión
// nueva borraba la caché vieja quedando sin nada para abrir sin conexión.
// cache: 'reload' saltea la caché HTTP del navegador (GitHub Pages la guarda 10 minutos):
// si no, la versión nueva podía guardar archivos de la anterior.
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                // 'bm-prefs' guarda el idioma para el push — nunca limpiarlo.
                keys.filter((k) => k !== CACHE && k !== 'bm-prefs').map((k) => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// Push del recordatorio diario. El Worker manda un push VACÍO (sin payload
// cifrado) — la notificación se compone acá, localmente. Mostrar una
// notificación es OBLIGATORIO en un push userVisibleOnly (si no, el browser
// muestra una genérica o penaliza la suscripción). El idioma lo escribe la
// app en el cache 'bm-prefs' (el SW no puede leer state/localStorage).
const PUSH_TEXTS = {
    es: '¡Hoy toca entrenar! Mantené tu racha viva.',
    en: 'Time to train! Keep your streak alive.',
    pt: 'Hoje é dia de treino! Mantenha sua sequência viva.'
};
self.addEventListener('push', (event) => {
    event.waitUntil((async () => {
        // Avisos con texto (los cifra el servidor): fin del descanso y avisos del coach.
        let data = null;
        try { data = event.data ? event.data.json() : null; } catch { data = null; }
        if (data && data.body) {
            return self.registration.showNotification(data.title || 'BERSERKERMOD', {
                body: String(data.body).slice(0, 300),
                icon: './icon-192.png',
                badge: './icon-192.png',
                tag: data.tag || 'bm-coach',
                renotify: true,
                data: { url: data.url || './BERSERKERMOD.html' }
            });
        }
        // Push vacío = recordatorio diario de entrenar (el texto lo pone el teléfono).
        let lang = 'es';
        try {
            const c = await caches.open('bm-prefs');
            const r = await c.match('./bm-prefs.json');
            if (r) {
                const p = await r.json();
                if (p && PUSH_TEXTS[p.lang]) lang = p.lang;
            }
        } catch { /* sin prefs → español */ }
        return self.registration.showNotification('BERSERKERMOD 💪', {
            body: PUSH_TEXTS[lang],
            icon: './icon-192.png',
            badge: './icon-192.png',
            tag: 'bm-daily-reminder',
            data: { url: './BERSERKERMOD.html' }
        });
    })());
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || './BERSERKERMOD.html';
    const target = new URL(url, self.registration.scope).href;
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (wins) => {
            for (const w of wins) {
                if (w.url.includes('BERSERKERMOD') && 'focus' in w) {
                    // Aviso del coach: lleva al link del alumno (su control, su evaluación)
                    if (url.includes('?r=') && w.url !== target && 'navigate' in w) { try { await w.navigate(target); } catch { /* sigue con focus */ } }
                    return w.focus();
                }
            }
            return self.clients.openWindow(target);
        })
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

    // HTML: primero la red, para tener siempre la última versión. Pero con señal mala (un
    // gimnasio en un subsuelo) la red no falla: se cuelga. Si en NET_TIMEOUT_MS no respondió
    // y hay una copia guardada, se muestra la copia y la red la actualiza por detrás.
    const isHtml = req.headers.get('accept')?.includes('text/html');

    if (isHtml) {
        const sameOrigin = url.origin === location.origin;
        // La copia se guarda sin la parte de "?…" (links de alumno, vuelta del pago): una por página
        const pageKey = url.origin + url.pathname;
        const net = fetch(req);
        event.waitUntil(net.then((res) => {
            if (!res.ok || !sameOrigin) return;
            const clone = res.clone();
            return caches.open(CACHE).then((c) => c.put(pageKey, clone));
        }).catch(() => {}));
        event.respondWith((async () => {
            const saved = sameOrigin ? ((await caches.match(req)) || (await caches.match(pageKey, { ignoreSearch: true }))) : null;
            const shell = async () => saved || (await caches.match('./BERSERKERMOD.html', { ignoreSearch: true })) || (await caches.match('./index.html', { ignoreSearch: true }));
            if (!saved) {
                try { return await net; } catch { return (await shell()) || Response.error(); }
            }
            try {
                const res = await Promise.race([net, new Promise((r) => setTimeout(() => r(null), NET_TIMEOUT_MS))]);
                if (res && (res.ok || res.status < 500)) return res;
            } catch { /* sin red */ }
            return saved;
        })());
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
