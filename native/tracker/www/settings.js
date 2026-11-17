// The Tracker's connection settings (docs/design/background-tracking.md, "Tracker settings screen"). Plain ES
// module with no platform calls, unit-tested from the main repo (tests/unit/native/tracker-settings.test.ts).
// Storage is the caller's job; this only checks, normalises and describes what is saved.

/** Same shape the server accepts (src/lib/device-token.ts): tdv_ + 20-100 of [A-Za-z0-9_-]. */
export const KEY_PATTERN = /^tdv_[A-Za-z0-9_-]{20,100}$/;

/**
 * Hosts that serve the PUBLIC website, not the app (src/lib/public-site.ts PUBLIC_SITE_HOSTS): a Tracker pointed
 * here would post positions to the website and every report would fail. Owner 2026-11-17: the domain changed.
 */
export const WEBSITE_ONLY_HOSTS = { "roadtolegacytrucking.com": "app.roadtolegacytrucking.com", "www.roadtolegacytrucking.com": "app.roadtolegacytrucking.com" };

/** Checks and normalises what was typed. Returns the values to save, or the plain-words problem. */
export function validateSettings(serverInput, keyInput) {
  const server = String(serverInput ?? "").trim().replace(/\/+$/, "");
  const key = String(keyInput ?? "").trim().replace(/^["']|["']$/g, "");
  let url;
  try {
    url = new URL(server);
  } catch {
    return { ok: false, field: "server", error: "Enter the server address, for example https://app.roadtolegacytrucking.com" };
  }
  if (url.protocol !== "https:") return { ok: false, field: "server", error: "The server address must start with https://" };
  if (!url.hostname || !url.hostname.includes(".")) return { ok: false, field: "server", error: "That doesn't look like a full web address." };
  const appHost = WEBSITE_ONLY_HOSTS[url.hostname.toLowerCase()];
  if (appHost) {
    return { ok: false, field: "server", error: "That address is the public website, not the app. Use https://" + appHost };
  }
  if (!KEY_PATTERN.test(key)) {
    return { ok: false, field: "key", error: "The key starts with tdv_ - copy it from the app: More -> Tracker app -> Phone keys." };
  }
  return { ok: true, server: url.origin + url.pathname.replace(/\/+$/, ""), key };
}

/** True when both saved values are usable for tracking. */
export function isConfigured(saved) {
  return Boolean(saved && saved.server && saved.key && validateSettings(saved.server, saved.key).ok);
}

/** What the main screen shows: the saved address and whether a key is saved - never the key itself. */
export function describeSaved(saved) {
  if (!saved || !saved.server) return { address: "No server saved yet", keyText: "No key saved yet" };
  let address = saved.server;
  try {
    address = new URL(saved.server).host;
  } catch {
    /* show it as saved */
  }
  const keyText = saved.key ? "Key saved (ends " + String(saved.key).slice(-4) + ")" : "No key saved yet";
  return { address, keyText };
}
