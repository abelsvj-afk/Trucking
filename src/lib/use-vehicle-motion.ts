"use client";

// Motion state for Home (docs/design/driver-hud.md §5). Watches the
// phone's GPS only while the page is visible; the reading is used for
// this one decision and is never stored or sent anywhere. No geolocation,
// permission denied, or a stale reading all report "unknown" (restricted).

import { useEffect, useRef, useState } from "react";
import { classifyMotion, type MotionState } from "./vehicle-motion";

const MPS_TO_MPH = 2.23694;
const RECHECK_MS = 5_000;

export function useVehicleMotion(): MotionState {
  const [state, setState] = useState<MotionState>("unknown");
  const lastRef = useRef<{ speedMph: number | null; atMs: number } | null>(null);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) return;
    let watchId: number | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const evaluate = () => {
      const last = lastRef.current;
      setState(last ? classifyMotion(last.speedMph, Date.now() - last.atMs) : "unknown");
    };
    const start = () => {
      if (watchId !== null) return;
      watchId = navigator.geolocation.watchPosition(
        (position) => {
          const s = position.coords.speed;
          lastRef.current = {
            speedMph: s !== null && s >= 0 ? s * MPS_TO_MPH : null,
            atMs: Date.now(),
          };
          evaluate();
        },
        () => {
          lastRef.current = null;
          evaluate();
        },
        { enableHighAccuracy: false, maximumAge: 10_000, timeout: 20_000 },
      );
      // Staleness is re-checked on a timer so a lost signal can't leave "stopped" standing.
      timer = setInterval(evaluate, RECHECK_MS);
    };
    const stop = () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
        lastRef.current = null;
        setState("unknown");
      } else {
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return state;
}
