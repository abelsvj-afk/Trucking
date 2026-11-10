// SW-STAMP regression (2026-11-04): the app-shell service worker's
// cache is only "versioned per deployment" if the build actually
// stamps the __BUILD_VERSION__ token in public/sw.js. The UH-10 fix
// assumed a build step replaced the token; none existed anywhere in
// the repo, so production served the raw file, BUILD_VERSION always
// evaluated to its fallback constant ("2026-11-02-fix1"), the cache
// name never rotated, and the activate-purge never fired — installed
// clients could hold a stale shell indefinitely (proven live: the
// served sw.js carried the unstamped token). These pins keep the
// stamp step, the token it replaces, and the retirement of the
// burned fallback constant from silently regressing.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("SW-STAMP: the Dockerfile stamps the service-worker build version", () => {
  it("Dockerfile replaces __BUILD_VERSION__ in public/sw.js before the Next build", () => {
    const lines = read("Dockerfile").split("\n");
    // The pin is on the RUN instruction itself, not a comment that
    // merely mentions the token.
    const stampIdx = lines.findIndex(
      (line) =>
        line.trimStart().startsWith("RUN") && line.includes("__BUILD_VERSION__"),
    );
    expect(stampIdx, "a Dockerfile RUN step stamps __BUILD_VERSION__").toBeGreaterThan(-1);
    const stampLine = lines[stampIdx];
    expect(stampLine).toContain("sed");
    expect(stampLine).toContain("public/sw.js");
    // The stamp must land before `next build` runs, or the built
    // image ships the unstamped file from public/.
    const buildIdx = lines.findIndex((line) => line.includes("npx next build"));
    expect(buildIdx).toBeGreaterThan(stampIdx);
  });

  it("public/sw.js still carries the __BUILD_VERSION__ token for the stamp to replace", () => {
    expect(read("public/sw.js")).toContain("__BUILD_VERSION__");
  });

  it("public/sw.js no longer carries the burned 2026-11-02 fallback constant", () => {
    expect(read("public/sw.js")).not.toContain("2026-11-02-fix1");
  });
});

describe("SW D4 (2026-11-10): HTML documents are never cache-first", () => {
  const sw = read("public/sw.js");

  it("documents route through the network-first branch", () => {
    expect(sw).toContain('url.pathname.endsWith(".html")');
    expect(sw).toContain('event.request.mode === "navigate" || url.pathname.endsWith(".html")');
  });

  it("the cache-first branch excludes .html outright", () => {
    expect(sw).toContain('!url.pathname.endsWith(".html")');
  });

  it("the unstamped fallback constant was bumped so stuck clients rotate once", () => {
    expect(sw).toContain("2026-11-10-conformance1");
    expect(sw).not.toContain("2026-11-04-swstamp1");
  });
});
