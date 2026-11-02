// App-shell service worker (Drive Mode D1): installability only.
//
// It deliberately does NOT cache pages or API responses. The app
// inlines per-deployment public config into its HTML at container
// start, so a cached shell would serve stale config - a
// correctness bug, not a feature. Only immutable static build
// assets and icons are cached, cache-first; every navigation and
// API call goes to the network untouched.
//
// This worker also never touches location: Drive Mode watches
// position only while the Drive page is open in the foreground
// (the honest first-run copy says exactly that), and nothing here
// changes it.
const CACHE = "trucking-os-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
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
  const cacheable =
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest";
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
