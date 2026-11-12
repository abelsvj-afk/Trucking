// Public-website host split (owner ruling 2026-11-10): the bare domain
// serves the public website, the app subdomain serves the app. The
// predicate in src/lib/public-site.ts is what src/proxy.ts consults on
// every request; these cases pin the exact contract the brief requires
// — including the service-worker carve-out (a subresource fetch is
// NEVER the public page, on any host).

import { describe, expect, it } from "vitest";
import { isPublicSiteRequest, PUBLIC_SITE_HOSTS } from "./public-site";

describe("isPublicSiteRequest", () => {
  it("serves the public page for a document navigation to the root host", () => {
    expect(
      isPublicSiteRequest("roadtolegacytrucking.com", "GET", "document"),
    ).toBe(true);
  });

  it("serves the public page for a document navigation to the www host", () => {
    expect(
      isPublicSiteRequest("www.roadtolegacytrucking.com", "GET", "document"),
    ).toBe(true);
  });

  it("serves the public page for a HEAD navigation (health checks, link previews)", () => {
    expect(
      isPublicSiteRequest("roadtolegacytrucking.com", "HEAD", "document"),
    ).toBe(true);
  });

  it("treats a missing sec-fetch-dest (non-browser client) as a navigation", () => {
    expect(isPublicSiteRequest("roadtolegacytrucking.com", "GET", null)).toBe(
      true,
    );
  });

  it("is case-insensitive and ignores a port on the host header", () => {
    expect(
      isPublicSiteRequest("RoadToLegacyTrucking.com:443", "GET", "document"),
    ).toBe(true);
  });

  it("never serves the app host the public page", () => {
    expect(
      isPublicSiteRequest("app.roadtolegacytrucking.com", "GET", "document"),
    ).toBe(false);
  });

  it("never serves other hosts (Fly hostname, localhost) the public page", () => {
    expect(isPublicSiteRequest("trucking.fly.dev", "GET", "document")).toBe(
      false,
    );
    expect(isPublicSiteRequest("localhost:3000", "GET", "document")).toBe(
      false,
    );
  });

  it("never rewrites a subresource fetch — the service worker install fetch keeps app semantics", () => {
    // public/sw.js installs by fetching "/" signed-out; that request is
    // same-origin with the APP even when triggered from elsewhere, and
    // its sec-fetch-dest is "empty", not "document".
    expect(isPublicSiteRequest("roadtolegacytrucking.com", "GET", "empty")).toBe(
      false,
    );
    expect(
      isPublicSiteRequest("www.roadtolegacytrucking.com", "GET", "script"),
    ).toBe(false);
    expect(
      isPublicSiteRequest("roadtolegacytrucking.com", "GET", "style"),
    ).toBe(false);
  });

  it("never rewrites non-GET/HEAD requests", () => {
    expect(
      isPublicSiteRequest("roadtolegacytrucking.com", "POST", "document"),
    ).toBe(false);
  });

  it("handles a missing host header", () => {
    expect(isPublicSiteRequest(null, "GET", "document")).toBe(false);
  });

  it("the public host set is exactly the bare domain and its www", () => {
    expect([...PUBLIC_SITE_HOSTS].sort()).toEqual([
      "roadtolegacytrucking.com",
      "www.roadtolegacytrucking.com",
    ]);
  });
});
