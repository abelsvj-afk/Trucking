// The floating HOS overlay's clock rules (docs/design/eld-roadside-overlay.md in the main repo). Plain ES
// module with no platform calls, unit-tested from the main repo (tests/unit/native/overlay.test.ts).
//
// SINGLE SOURCE OF TRUTH: the numbers come from the Trucking OS server
// (POST /api/v1/position/clocks), which computes them with the one HOS
// read every other surface uses. This module only FORMATS what the server
// sent - it contains no HOS math of its own, and it invents nothing: a
// malformed or missing response produces null, and the overlay hides
// rather than showing made-up clocks.

/** The clocks endpoint for a saved server base URL (settings.js already normalised it). */
export function clocksUrl(server) {
  return String(server ?? "").replace(/\/+$/, "") + "/api/v1/position/clocks";
}

/** Compact H:MM for the overlay card (8h 5m -> "8:05"); never negative. */
export function formatRemaining(ms) {
  const totalSec = Math.max(0, Math.floor(Number(ms) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return h + ":" + String(m).padStart(2, "0");
}

const STATUS_TEXT = {
  off_duty: "Off duty",
  sleeper: "Sleeper berth",
  driving: "Driving",
  on_duty: "On duty",
};

const CLOCK_ORDER = ["drive", "window", "break", "cycle"];
const CLOCK_SHORT = { drive: "DRIVE", window: "WINDOW", break: "BREAK", cycle: "70-HR" };

/**
 * Validates a clocks response and shapes the payload for the native
 * overlay plugin: { state, statusText, lines: [{ label, text, tone }] }.
 * Returns null for anything that is not a well-formed server answer.
 */
export function overlayPayload(json, nowMs) {
  const data = json && typeof json === "object" ? json.data : null;
  if (!data || typeof data !== "object") return null;
  if (data.state === "no-logs") {
    return { state: "no-logs", statusText: "No logs yet", lines: [], computedAtMs: Date.parse(data.computedAt) || nowMs };
  }
  if (data.state !== "ready" || !Array.isArray(data.clocks)) return null;
  const byKey = new Map();
  for (const c of data.clocks) {
    if (c && typeof c.key === "string" && typeof c.remainingMs === "number") byKey.set(c.key, c);
  }
  const lines = [];
  for (const key of CLOCK_ORDER) {
    const c = byKey.get(key);
    if (!c) return null; // a partial clock set is worse than none - hide rather than mislead
    lines.push({
      label: CLOCK_SHORT[key],
      // The native card counts down from this anchored value between polls
      // and re-anchors on every poll - display smoothing only.
      remainingMs: c.remainingMs,
      text: formatRemaining(c.remainingMs),
      tone: c.tone === "expired" || c.remainingMs <= 0 ? "expired" : c.tone === "warn" ? "warn" : "ok",
    });
  }
  return {
    state: "ready",
    statusText: STATUS_TEXT[data.status] ?? "On the clock",
    lines,
    computedAtMs: Date.parse(data.computedAt) || nowMs,
  };
}

/** Poll cadence for fresh server clocks (display refresh only). */
export const OVERLAY_POLL_MS = 30_000;
