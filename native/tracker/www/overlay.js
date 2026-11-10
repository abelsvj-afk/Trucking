// The floating HOS overlay's glue (docs/design/eld-roadside-overlay.md in the main repo): polls the server's
// clocks endpoint with the SAVED server + device key and hands the formatted values to the native
// HosOverlay plugin, which draws the always-on-top card. The card is drawn by a native service, so it
// stays on screen after this app closes, until it is dismissed there or switched off here.
//
// Display only: no duty controls, no HOS math (overlay-clocks.js formats; the server computes). A failed
// poll keeps the last good values on screen - the native card counts down from the last server answer and
// the next poll re-anchors it - and repeated failures are logged in the connection log, never silent.

import { clocksUrl, overlayPayload, OVERLAY_POLL_MS } from "./overlay-clocks.js";
import { isConfigured } from "./settings.js";

export function createOverlay({ plugin, getSaved, fetchFn, log }) {
  let timer = null;
  let running = false;
  let failures = 0;

  async function poll() {
    const saved = getSaved();
    if (!isConfigured(saved)) {
      stop();
      return;
    }
    let payload = null;
    try {
      const res = await fetchFn(clocksUrl(saved.server), {
        method: "POST",
        headers: { Authorization: "Bearer " + saved.key, "Content-Type": "application/json" },
        body: "{}",
      });
      if (res && res.ok) payload = overlayPayload(await res.json(), Date.now());
      if (res && res.status === 401) {
        // The key was refused: stop polling and say so once - the card hides rather than showing stale clocks.
        log("ERROR", "The server refused this key for the HOS clocks - the floating clocks stopped. Make a new key in Trucking OS if this one was revoked.");
        stop();
        return;
      }
    } catch {
      payload = null;
    }
    if (payload) {
      failures = 0;
      try {
        await plugin.show(payload);
      } catch {
        /* the native side reports its own errors; the next poll retries */
      }
    } else {
      failures += 1;
      if (failures === 3) log("ERROR", "The HOS clocks aren't updating (the server didn't answer) - the card is counting down from the last answer and will refresh when the connection is back.");
    }
  }

  function start() {
    if (running || !plugin) return;
    running = true;
    void poll();
    timer = setInterval(() => void poll(), OVERLAY_POLL_MS);
  }

  function stop() {
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
    if (plugin) void plugin.hide().catch(() => undefined);
  }

  return { start, stop, isRunning: () => running };
}
