// PWA installability (owner report 2026-11-07): Chrome said "this
// app cannot be installed" because the proxy redirected signed-out
// requests for /sw.js (and the manifest) to /login - Chrome's
// install check runs signed-out, so it never saw an installable app.
// These pins keep exactly the static PWA assets public, keep every
// real page behind the login redirect, and keep the manifest's
// locked branding complete.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("PWA install: the proxy lets signed-out Chrome see the install assets", () => {
  const proxy = read("src/proxy.ts");
  const publicPathsLine = proxy.split("\n").find((line) => line.includes("const PUBLIC_PATHS")) ?? "";

  it("PUBLIC_PATHS includes the service worker and the manifest, as exact asset paths", () => {
    expect(publicPathsLine).toContain('"/sw.js"');
    expect(publicPathsLine).toContain('"/manifest.webmanifest"');
  });

  it("PUBLIC_PATHS does not widen to any page, the root, or a catch-all prefix", () => {
    expect(publicPathsLine).not.toContain('"/",');
    // The sanctioned /api/v1 exemptions after the prefix: health (no data),
    // position/feed and position/clocks (the Tracker's device-token routes -
    // no browser session exists in native code; each route enforces its own
    // fail-closed Bearer-token check and is scoped to the token's company;
    // clocks added by the ELD overlay build, docs/design/eld-roadside-overlay.md).
    // Any OTHER /api/v1 path going public must extend this list deliberately.
    expect(publicPathsLine).not.toMatch(/"\/money|\/loads|\/fleet|\/more|\/api\/v1\/(?!health|position\/feed|position\/clocks)/);
  });

  it("the signed-out redirect to /login still guards everything non-public", () => {
    expect(proxy).toContain("if (!user && !isPublicPath)");
    expect(proxy).toContain('new URL("/login", request.url)');
  });

  it("the matcher still exempts the icon image files from the proxy", () => {
    expect(proxy).toContain("svg|png|jpg|jpeg|gif|webp");
  });
});

describe("PWA install: the manifest carries the locked branding, complete", () => {
  const manifest = JSON.parse(read("public/manifest.webmanifest")) as {
    name: string;
    short_name: string;
    display: string;
    start_url: string;
    icons: { src: string; sizes: string; purpose?: string }[];
  };

  it("names the app as locked", () => {
    expect(manifest.name).toBe("Road to Legacy — Trucking Business OS");
    expect(manifest.short_name).toBe("Legacy");
  });

  it("is installable-shaped: standalone display and a start URL", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
  });

  it("ships the 192 and 512 icons plus a maskable icon", () => {
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes.filter((s) => s === "512x512").length).toBeGreaterThanOrEqual(2);
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
  });
});
