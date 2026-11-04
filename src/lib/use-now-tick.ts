"use client";

// A once-a-second clock for live displays (docs/design/driver-hud.md
// §2). No network: it only advances "now". It stops while the page is
// hidden (no work, no battery) and re-syncs the instant the page is
// visible again so a resumed tab never shows a stale second.

import { useEffect, useState } from "react";

export function useNowTick(intervalMs = 1000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => setNowMs(Date.now()), intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        setNowMs(Date.now());
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);

  return nowMs;
}
