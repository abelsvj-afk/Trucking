// The Tracker's Start button was dead on the owner's phone (2026-11-07): the page called Capacitor.registerPlugin,
// which only Capacitor's JS core provides - the Android native bridge alone does not - and the page never loaded the
// core, so the script threw on load and no click handler was ever attached. Verified by loading the old and new page
// in Chromium against a native-bridge stand-in. These checks keep the page wired the way that works.

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";

const html = readFileSync("native/tracker/www/index.html", "utf8");
const script = readFileSync("native/tracker/www/tracker.js", "utf8");

describe("Tracker page wiring", () => {
  it("loads Capacitor's JS core BEFORE the tracker script", () => {
    const core = html.indexOf('src="./capacitor-core.js"');
    const tracker = html.indexOf('src="./tracker.js"');
    expect(core).toBeGreaterThan(-1);
    expect(tracker).toBeGreaterThan(core);
  });
  it("ships the core file itself, copied from the pinned @capacitor/core", () => {
    expect(existsSync("native/tracker/www/capacitor-core.js")).toBe(true);
    const vendored = readFileSync("native/tracker/www/capacitor-core.js", "utf8");
    expect(vendored).toContain("registerPlugin");
    // Byte-identical to the pinned package when the tracker's dependencies are installed (npm ci in native/tracker).
    const pinnedPath = "native/tracker/node_modules/@capacitor/core/dist/capacitor.js";
    if (existsSync(pinnedPath)) expect(vendored).toBe(readFileSync(pinnedPath, "utf8"));
  });
  it("never calls registerPlugin without checking it exists, and shows page errors in the status box", () => {
    expect(script).not.toMatch(/Cap\.registerPlugin\(/);
    expect(html).toMatch(/addEventListener\("error"/);
    expect(html).toMatch(/addEventListener\("unhandledrejection"/);
  });
});
