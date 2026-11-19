"use client";

// Keep the phone's screen on while the drive map is open (owner
// 2026-11-19: "the map needs to keep the screen awake"). Uses the
// browser's Screen Wake Lock API (Chrome on Android supports it over
// https). The browser drops the lock whenever the page is hidden, so it
// is asked for again each time the page comes back. Where the browser
// can't do it, the Tracker app's map screen keeps the screen on
// natively (MapActivity, FLAG_KEEP_SCREEN_ON) — the status says which.

import { useEffect, useState } from "react";

export type WakeLockStatus = "on" | "unsupported" | "refused" | "off";

interface WakeLockSentinelLike {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: "release", cb: () => void) => void;
}

export function useScreenWakeLock(active: boolean): WakeLockStatus {
  const [status, setStatus] = useState<WakeLockStatus>("off");

  useEffect(() => {
    if (!active) return;
    const api = (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<WakeLockSentinelLike> } }).wakeLock;
    if (!api) {
      queueMicrotask(() => setStatus("unsupported"));
      return;
    }
    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== "visible" || (sentinel && !sentinel.released)) return;
      try {
        sentinel = await api.request("screen");
        if (cancelled) {
          void sentinel.release();
          return;
        }
        setStatus("on");
        sentinel.addEventListener("release", () => {
          if (!cancelled) setStatus("off");
        });
      } catch {
        if (!cancelled) setStatus("refused");
      }
    };
    const onVisible = () => void acquire();
    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active]);

  return active ? status : "off";
}
