"use client";

// Motion state for Home (docs/design/driver-hud.md §5). Watches the
// phone's GPS only while the page is visible; the reading is used for
// this one decision and is never stored or sent anywhere. No geolocation,
// permission denied, or a stale reading all report "unknown" (restricted).

import { useEffect, useRef, useState } from "react";
import { classifyMotion, settleMotion, type MotionState } from "./vehicle-motion";

const MPS_TO_MPH = 2.23694;
const RECHECK_MS = 5_000;

export interface VehiclePosition {
  lat: number;
  lng: number;
  accuracyM: number;
  atMs: number;
}

export interface VehicleMotionDetail {
  state: MotionState;
  /** The latest fix, or null when there isn't one (never a stale guess presented as live). */
  position: VehiclePosition | null;
}

/** Motion state only (the safety decision). */
export function useVehicleMotion(): MotionState {
  return useVehicleMotionDetail().state;
}

export function useVehicleMotionDetail(): VehicleMotionDetail {
  const [state, setState] = useState<MotionState>("unknown");
  const [position, setPosition] = useState<VehiclePosition | null>(null);
  const lastRef = useRef<{ speedMph: number | null; atMs: number } | null>(null);
  // When the current uninterrupted stop began (null while moving/unknown).
  const stoppedSinceRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) return;
    let watchId: number | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const evaluate = () => {
      const last = lastRef.current;
      const raw = last ? classifyMotion(last.speedMph, Date.now() - last.atMs) : "unknown";
      if (raw === "stopped") {
        if (stoppedSinceRef.current === null) stoppedSinceRef.current = Date.now();
      } else {
        stoppedSinceRef.current = null;
      }
      setState(settleMotion(raw, stoppedSinceRef.current === null ? null : Date.now() - stoppedSinceRef.current));
    };
    const start = () => {
      if (watchId !== null) return;
      watchId = navigator.geolocation.watchPosition(
        (fix) => {
          const s = fix.coords.speed;
          lastRef.current = {
            speedMph: s !== null && s >= 0 ? s * MPS_TO_MPH : null,
            atMs: Date.now(),
          };
          setPosition({
            lat: fix.coords.latitude,
            lng: fix.coords.longitude,
            accuracyM: fix.coords.accuracy,
            atMs: Date.now(),
          });
          evaluate();
        },
        () => {
          lastRef.current = null;
          setPosition(null);
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
        stoppedSinceRef.current = null;
        setPosition(null);
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

  return { state, position };
}
