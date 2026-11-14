// ============================================================
// WILLFORTUNATE SERVICE WORKER
// ------------------------------------------------------------
// Strategy: NETWORK-FIRST with cache fallback + a 2 s cap.
//
//   • Fresh when the network is healthy   → the new index.html
//     is served immediately, exactly as if no SW existed.
//   • Fast when the network is cold/slow  → if the network does
//     not answer within 2 s, the last known-good copy is served
//     from the cache, so the app opens instead of stalling.
//   • Never stranded on a stale build     → the cache is only
//     ever a FALLBACK, never the default. A failed deploy cannot
//     lock users into an old shell.
//
// What is cached:
//   • The app shell (index.html / new/ / the page itself)
//   • The 5 CDN libraries already referenced by the shell
//     (FontAwesome, Google Fonts, Cropper, EmailJS, Supabase JS)
//
// What is NOT cached:
//   • Any Supabase API call (POST/PUT/DELETE, and any GET whose
//     URL contains /rest/v1/ or /auth/v1/ or /realtime/v1/).
//     The admin panel and realtime sync must always hit the live
//     server so admin changes propagate exactly as they do now.
//   • Any cross-origin request that is not in PRECACHE_URLS.
//
// Bump CACHE_VERSION whenever you change the shell in a way that
// must not be served stale. Old caches are deleted on activate.
// ============================================================

const CACHE_VERSION  = 'wf-shell-v1';
const NETWORK_TIMEOUT = 2000;   // ms — cap on the network attempt

// The shell + every CDN asset the HTML references.
const PRECACHE_URLS = [
    './',
    './index.html',
    './new/',
    './new/index.html',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@300;400;500;600;700;800&display=swap',
    'https://cdn.jsdelivr.net/npm/cropperjs@1.5.12/dist/cropper.min.js',
    'https://cdn.jsdelivr.net/npm/cropperjs@1.5.12/dist/cropper.min.css',
    'https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

// URLs that must NEVER be intercepted — the admin panel and
// realtime sync depend on always seeing the live server.
function isApiRequest(url) {
    try {
        const u = new URL(url);
        return (
            u.pathname.startsWith('/rest/v1/') ||
            u.pathname.startsWith('/auth/v1/') ||
            u.pathname.startsWith('/realtime/v1/') ||
            u.pathname.startsWith('/storage/v1/') ||
            /supabase\.co$/.test(u.hostname)
        );
    } catch (e) {
        return false;
    }
}

// ============================================================
// INSTALL — pre-cache the shell so the first fallback exists.
// ============================================================
self.addEventListener('install', function (event) {
    event.waitUntil((async function () {
        try {
            const cache = await caches.open(CACHE_VERSION);
            // addAll fails the whole batch if any single URL 404s.
            // Add each individually and ignore failures so one dead
            // CDN URL cannot break the install.
            await Promise.all(PRECACHE_URLS.map(async function (url) {
                try { await cache.add(url); } catch (e) { }
            }));
        } catch (e) { }
        // Activate immediately — no waiting on old tabs.
        await self.skipWaiting();
    })());
});

// ============================================================
// ACTIVATE — delete every cache except the current one.
// ============================================================
self.addEventListener('activate', function (event) {
    event.waitUntil((async function () {
        try {
            const names = await caches.keys();
            await Promise.all(names.map(function (n) {
                if (n !== CACHE_VERSION) return caches.delete(n);
            }));
        } catch (e) { }
        await self.clients.claim();
    })());
});

// ============================================================
// FETCH — network-first, 2 s cap, cache fallback.
// ============================================================
self.addEventListener('fetch', function (event) {
    const req = event.request;

    // Only GET requests. POST/PUT/DELETE go straight to the network.
    if (req.method !== 'GET') return;

    // Supabase API traffic — never intercept.
    if (isApiRequest(req.url)) return;

    // Only same-origin or known CDN assets.
    const isPrecached = PRECACHE_URLS.indexOf(req.url) !== -1;
    let isSameOrigin = false;
    try { isSameOrigin = (new URL(req.url).origin === self.location.origin); } catch (e) { }
    if (!isSameOrigin && !isPrecached) return;

    event.respondWith((async function () {
        const cache = await caches.open(CACHE_VERSION);

        // Race the network against a timeout.
        const networkPromise = fetch(req).then(function (res) {
            // Only cache good responses.
            if (res && res.status === 200 && res.type !== 'opaque') {
                try { cache.put(req, res.clone()); } catch (e) { }
            }
            return res;
        });

        const timeoutPromise = new Promise(function (resolve) {
            setTimeout(function () { resolve(null); }, NETWORK_TIMEOUT);
        });

        const winner = await Promise.race([networkPromise, timeoutPromise]);

        if (winner) return winner;

        // Network was too slow — serve the cached copy if we have one.
        const cached = await cache.match(req);
        if (cached) return cached;

        // No cache hit — fall back to the network even if slow.
        try { return await networkPromise; } catch (e) { }

        // Absolute last resort — an offline stub for navigation requests.
        if (req.mode === 'navigate') {
            return new Response(
                '<!doctype html><html><body style="background:#0a0e17;color:#4dabf7;font-family:system-ui;text-align:center;padding:60px 20px;">' +
                '<h1>Offline</h1><p>The app could not reach the network and no cached copy is available.</p>' +
                '</body></html>',
                { headers: { 'Content-Type': 'text/html' } }
            );
        }
        return new Response('', { status: 503, statusText: 'Service Unavailable' });
    })());
});