// The public one-page website, served by src/proxy.ts for top-level
// navigations to roadtolegacytrucking.com / www.roadtolegacytrucking.com
// (owner ruling 2026-11-10: the bare domain shows the website; the app
// lives on app.roadtolegacytrucking.com). The page content is the
// exported website checked in at public-site/index.html and embedded in
// ./public-site-html — served from memory, byte-for-byte, so the hero
// image and inline scripts arrive exactly as exported.
//
// This handler exists as a route only so the proxy has an internal
// rewrite target; the proxy rewrites public-host navigations here
// BEFORE its auth gate, so no session is needed (or consulted) for the
// public page. Direct hits on /public-site on the app host 404 below:
// the website is a bare-domain surface, not an app page.

import { PUBLIC_SITE_HTML } from "./public-site-html";

function pageResponse(): Response {
  return new Response(PUBLIC_SITE_HTML, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The page is a checked-in file; let browsers and Fly's edge hold
      // it briefly so repeat visits are instant, while a redeploy still
      // replaces it within the hour.
      "cache-control": "public, max-age=3600",
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  // The proxy marks the requests it rewrote here. Fly terminates TLS
  // and this app trusts the platform's forwarded headers (the proxy's
  // own session handling already relies on request.url's forwarded
  // host), so an unmarked hit on this path is a direct app-host visit.
  if (request.headers.get("x-public-site-rewrite") !== "1") {
    return new Response("Not found", { status: 404 });
  }
  return pageResponse();
}

export async function HEAD(request: Request): Promise<Response> {
  if (request.headers.get("x-public-site-rewrite") !== "1") {
    return new Response(null, { status: 404 });
  }
  const res = pageResponse();
  return new Response(null, { status: res.status, headers: res.headers });
}
