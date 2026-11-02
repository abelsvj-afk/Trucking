// GAP-07 (Fresh-Eyes Register 2026-11-02): minimal service worker.
// App-shell caching only — API traffic is NEVER intercepted (the
// offline outbox in src/lib/offline-outbox.ts owns queued writes;
// caching API responses here would serve stale money data).
// Static assets: cache-first. Navigations: network-first with a
// cached-shell fallback so the app opens in a dead zone and the
// outbox forms can still capture.
const CACHE = "trucking-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/")) return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/").then((r) => r ?? Response.error())),
    );
    return;
  }
  if (url.pathname.startsWith("/_next/static/") || SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ??
          fetch(event.request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            return res;
          }),
      ),
    );
  }
});
