// Unified app-shell service worker (Drive Mode D1 + GAP-07) — exactly
// one worker for the app. UH-10 fix (union fix round): the cache is
// VERSIONED per deployment and navigations can never serve an
// indefinitely stale shell.
//
// - BUILD_VERSION is stamped at build/deploy time (the composition
//   replaces __BUILD_VERSION__; when unstamped it falls back to a
//   dated constant that MUST be bumped with any shell change). The
//   cache name derives from it, and activate deletes EVERY other
//   cache, so a new deploy reliably retires the old shell.
// - Navigations are network-first for EVERY path: any successful
//   navigation (not just "/") refreshes the cached "/" shell entry,
//   so a driver who habitually enters on a subpath (Drive, Smart
//   Path) still gets a fresh shell. The cached "/" is served ONLY
//   when the network fetch fails outright (dead zone), preserving
//   GAP's offline-outbox intent with a bounded fallback.
// - API traffic is NEVER intercepted; non-GET and cross-origin pass
//   through. Location is never touched.
const BUILD_VERSION = "__BUILD_VERSION__" === "__BUILD" + "_VERSION__" ? "2026-11-02-fix1" : "__BUILD_VERSION__";
const CACHE = `trucking-os-shell-${BUILD_VERSION}`;
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Navigations: network-first; ANY successful navigation refreshes
  // the cached shell; cached "/" only on outright network failure.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) =>
              // Cache the shell entry from "/" itself; for other
              // paths, refresh "/" in the background so the fallback
              // shell tracks the current deploy.
              url.pathname === "/"
                ? cache.put("/", copy)
                : fetch("/").then((r) => (r.ok ? cache.put("/", r) : undefined)).catch(() => undefined),
            );
          }
          return response;
        })
        .catch(() => caches.match("/").then((r) => r ?? Response.error())),
    );
    return;
  }

  // Immutable static assets + shell files: cache-first.
  const cacheable =
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    SHELL.includes(url.pathname);
  if (!cacheable) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const response = await fetch(event.request);
      if (response.ok) {
        void cache.put(event.request, response.clone());
      }
      return response;
    }),
  );
});
