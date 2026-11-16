// The Tracker's Start button was dead on the owner's phone (2026-11-07): the page called Capacitor.registerPlugin,
// which only Capacitor's JS core provides - the Android native bridge alone does not - and the page never loaded the
// core, so the script threw on load and no click handler was ever attached. Verified by loading the old and new page
// in Chromium against a native-bridge stand-in. These checks keep the page wired the way that works.

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

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
  it("has a separate settings screen with server URL + key, and the main screen shows the saved address", () => {
    expect(html).toMatch(/id="main-view"/);
    expect(html).toMatch(/id="settings-view"[^>]*hidden/);
    expect(html).toMatch(/id="server"/);
    expect(html).toMatch(/id="key" type="password"/);
    expect(html).toMatch(/id="saved-address"/);
    // tracking sends with the SAVED values, never the raw input fields
    expect(script).toMatch(/Tracker\.start\(\{ server: saved\.server, key: saved\.key \}\)/);
    expect(script).not.toMatch(/server: \$\("server"\)/);
  });
  it("sends through Android's native HTTP, not the WebView's CORS-checked fetch", () => {
    const cfg = JSON.parse(readFileSync("native/tracker/capacitor.config.json", "utf8")) as { plugins?: { CapacitorHttp?: { enabled?: boolean } } };
    expect(cfg.plugins?.CapacitorHttp?.enabled).toBe(true);
  });
  it("shows the exact last error and keeps a connection log", () => {
    expect(html).toMatch(/id="log"/);
    expect(script).toMatch(/lastError/);
    expect(script).toMatch(/logEvent\("ERROR"/);
    expect(script).toMatch(/scrubKey\(message, saved\.key\)/);
    expect(script).not.toMatch(/can't reach the server \(will keep trying\)/);
  });
});

// Owner 2026-11-16: "only tracking when I open it", and the notification was gone. The old plugin's service
// stopped itself when the app closed (onUnbind -> stopSelf) and only the page sent positions. Tracking is now a
// native foreground service that reads and sends on its own.
describe("tracking runs natively, with the app closed", () => {
  const read = (p: string) => readFileSync(path.join(process.cwd(), "native/tracker", p), "utf8");
  const service = read("android/app/src/main/java/com/truckingos/tracker/TrackerService.java");
  const manifest = read("android/app/src/main/AndroidManifest.xml");

  it("the page no longer depends on the old background-geolocation plugin to track", () => {
    const script = read("www/tracker.js");
    expect(script).not.toMatch(/BackgroundGeolocation|addWatcher/);
    expect(script).toMatch(/registerPlugin\("Tracker"\)/);
  });

  it("a location foreground service with its notification, declared with the permissions it needs", () => {
    expect(manifest).toMatch(/android:name="\.TrackerService"[\s\S]*?android:foregroundServiceType="location"/);
    for (const perm of ["ACCESS_FINE_LOCATION", "FOREGROUND_SERVICE", "FOREGROUND_SERVICE_LOCATION", "POST_NOTIFICATIONS"]) {
      expect(manifest).toContain(`android.permission.${perm}`);
    }
    expect(service).toMatch(/startForeground\(NOTIFICATION_ID, n, ServiceInfo\.FOREGROUND_SERVICE_TYPE_LOCATION\)/);
    expect(service).toContain("setOngoing(true)");
  });

  it("keeps running when the app is closed or swiped away, and sends positions itself", () => {
    expect(service).toContain("return START_STICKY;");
    const onTaskRemoved = service.slice(service.indexOf("public void onTaskRemoved"), service.indexOf("public void onDestroy"));
    expect(onTaskRemoved).not.toMatch(/stopSelf|stop\(/);
    expect(service).toContain('"/api/v1/position/feed"');
    expect(service).toContain('"Bearer " + key');
    expect(service).not.toMatch(/public boolean onUnbind/);
  });

  it("the key never reaches the log", () => {
    expect(service).toMatch(/message\.replace\(key, "tdv_\[hidden\]"\)/);
  });
});
