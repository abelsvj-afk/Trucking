// Source-level pins for the public-website serving change (owner
// ruling 2026-11-10), in the house style of the other *-source tests:
// the behavioral predicate is unit-tested in src/lib/public-site.test
// .ts; these pins keep the wiring honest — the proxy consults the
// predicate on the Host header (never the rewritten URL), the route
// only answers proxy-marked requests, the embedded page is the export
// byte-for-byte, and the service worker's documented contract stays
// consistent with the proxy's split.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("public website serving — proxy wiring", () => {
  const proxy = read("src/proxy.ts");

  it("consults the public-site predicate before the session work", () => {
    const gate = proxy.indexOf("isPublicSiteRequest(");
    const session = proxy.indexOf("createServerClient(");
    expect(gate).toBeGreaterThan(-1);
    expect(session).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(session);
  });

  it("keys the decision on the Host header and sec-fetch-dest, never the URL hostname", () => {
    expect(proxy).toContain('request.headers.get("host")');
    expect(proxy).toContain('request.headers.get("sec-fetch-dest")');
    // Code must never READ the URL hostname for the decision. (The
    // proxy's own comment mentions the property while explaining why
    // it is avoided; strip comments before pinning the code.)
    const codeOnly = proxy
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toContain("nextUrl.hostname");
  });

  it("rewrites to /public-site with the marker header, and keeps the auth gate from redirecting it", () => {
    expect(proxy).toContain('url.pathname = "/public-site"');
    expect(proxy).toContain('headers.set("x-public-site-rewrite", "1")');
    expect(proxy).toContain('"/public-site"');
  });
});

describe("public website serving — route + embedded page", () => {
  it("the route answers only proxy-marked requests and serves the embedded page", () => {
    const route = read("src/app/public-site/route.ts");
    expect(route).toContain('request.headers.get("x-public-site-rewrite")');
    expect(route).toContain("PUBLIC_SITE_HTML");
    expect(route).toContain("status: 404");
  });

  it("the checked-in page exists and is the export, byte-for-byte", () => {
    const file = path.join(root, "public-site/index.html");
    expect(existsSync(file)).toBe(true);
    const html = readFileSync(file, "utf8");
    // Owner-approved copy + hero: headline, embedded hero image, and
    // the Customer Login link target are the load-bearing pieces.
    expect(html).toContain("The man who books your freight");
    expect(html).toContain('class="hero-img" src="data:image/webp;base64,');
    expect(html).toContain('href="https://app.roadtolegacytrucking.com"');
    expect(html).toContain(">Customer Login<");
  });

  it("the embedded bundle copy matches the checked-in page exactly", () => {
    const ts = read("src/app/public-site/public-site-html.ts");
    const html = readFileSync(path.join(root, "public-site/index.html"), "utf8");
    const embedded = JSON.parse(
      ts.slice(ts.indexOf("= ") + 2).replace(/;\s*$/, ""),
    ) as string;
    expect(embedded).toBe(html);
    expect(createHash("sha256").update(embedded).digest("hex")).toBe(
      createHash("sha256").update(html).digest("hex"),
    );
  });

  it("the page does NOT live under public/ (it would shadow the app root + PWA shell)", () => {
    expect(existsSync(path.join(root, "public/index.html"))).toBe(false);
  });
});

describe("public website serving — service worker contract", () => {
  it("sw.js stays consistent with the split: navigations network-first, the public-origin note present", () => {
    const sw = read("public/sw.js");
    expect(sw).toContain("roadtolegacytrucking.com");
    expect(sw).toContain('event.request.mode === "navigate"');
  });
});
