// Public-website host routing (owner ruling 2026-11-10): the bare domain
// roadtolegacytrucking.com and its www host serve the PUBLIC one-page
// website; app.roadtolegacytrucking.com (and every other host — Fly's
// own hostname, localhost, preview URLs) serves the trucking app. The
// Fly "trucking" app holds certificates for all three hostnames and DNS
// points all three at this one deployment, so the split happens here,
// on the request's host, in src/proxy.ts.
//
// The page itself is the exported public website, checked in verbatim
// at public-site/index.html and inlined into the bundle by
// src/app/public-site/route.ts — it must NOT live under public/,
// because the service worker install fetches "/" signed-out on the APP
// host; if a file existed at public/index.html, Next would serve it for
// the app root instead of the app shell and break the PWA.

/** Hosts that receive the public website instead of the app. */
export const PUBLIC_SITE_HOSTS: ReadonlySet<string> = new Set([
  "roadtolegacytrucking.com",
  "www.roadtolegacytrucking.com",
]);

/**
 * The `sec-fetch-dest: document` value marks a genuine top-level
 * navigation. The proxy keys the public-site decision on it (plus the
 * request method) so that ONLY page loads get the public page, while
 * same-origin subresource fetches issued BY the app shell — the
 * service worker install fetch of "/" above all — keep app semantics
 * on every host. See src/proxy.ts for the full reasoning at the
 * call site, and the note in public/sw.js.
 */
export function isPublicSiteRequest(
  hostHeader: string | null,
  method: string,
  secFetchDest: string | null,
): boolean {
  if (!hostHeader) return false;
  // Host may carry a port (local dev, preview deploys); compare the
  // bare hostname, case-insensitively.
  const hostname = (hostHeader.split(":")[0] ?? "").trim().toLowerCase();
  if (!PUBLIC_SITE_HOSTS.has(hostname)) return false;
  if (method !== "GET" && method !== "HEAD") return false;
  // A missing header means a non-browser client; treat it like a
  // navigation — the public page is the right answer for a bare-domain
  // fetch either way.
  return secFetchDest === null || secFetchDest === "document";
}
