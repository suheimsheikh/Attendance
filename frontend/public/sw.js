/**
 * I Showed Up — minimal service worker.
 *
 * Strategy: app-shell precache + network-first for everything else. We keep
 * this DELIBERATELY small because the app is an attendance dashboard — fresh
 * data is far more important than offline support. The SW exists mostly to
 * make Chrome/Android consider the site "installable" (PWA criteria require
 * a registered SW) and to eliminate the white-flash on cold launch by
 * serving the cached index.html instantly.
 */
const CACHE = "ishowedup-shell-v1";
const SHELL = ["/", "/index.html", "/manifest.json", "/favicon.png",
               "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Drop old shell caches on version bump.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only handle GETs we serve ourselves. Never cache /api/* — always live.
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) return;
  if (url.origin !== self.location.origin) return;

  // Network-first for HTML so updates land immediately on next visit;
  // fall back to the cached shell when offline.
  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then((r) => r || caches.match("/index.html")))
    );
    return;
  }

  // Cache-first for static assets — speeds up repeat loads.
  event.respondWith(
    caches.match(req).then((cached) =>
      cached || fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
    )
  );
});
