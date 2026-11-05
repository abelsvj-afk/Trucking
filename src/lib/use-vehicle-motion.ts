"use client";

// Motion state for Home (docs/design/driver-hud.md §5). Watches the
// phone's GPS only while the page is visible; the reading is used for
// this one decision and is never stored or sent anywhere. No geolocation,
// permission denied, or a stale reading all report "unknown" (restricted).

import { useEffect, useRef, useState } from "react";
import type { MotionState } from "./vehicle-motion";
import { NO_ESTIMATE, motionState, stepMotion, type MotionEstimate } from "./motion-estimator";

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
  // The bubble estimator (lib/motion-estimator): wander inside the bubble
  // around where he stopped is not movement; see that file for the rules.
  const estimateRef = useRef<MotionEstimate>(NO_ESTIMATE);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) return;
    let watchId: number | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const evaluate = () => setState(motionState(estimateRef.current, Date.now()));
    const start = () => {
      if (watchId !== null) return;
      watchId = navigator.geolocation.watchPosition(
        (fix) => {
          const s = fix.coords.speed;
          const now = Date.now();
          const next = stepMotion(estimateRef.current, {
            lat: fix.coords.latitude,
            lng: fix.coords.longitude,
            accuracyM: fix.coords.accuracy,
            atMs: now,
            speedMph: s !== null && s >= 0 ? s * MPS_TO_MPH : null,
          });
          estimateRef.current = next;
          // A poor fix leaves the estimate untouched; the position shown is the
          // estimate's (pinned while parked), not the raw wobbling reading.
          const shown = next.displayPoint ?? { lat: fix.coords.latitude, lng: fix.coords.longitude };
          setPosition({ lat: shown.lat, lng: shown.lng, accuracyM: fix.coords.accuracy, atMs: now });
          evaluate();
        },
        () => {
          estimateRef.current = NO_ESTIMATE;
          setPosition(null);
          evaluate();
        },
        // High accuracy: the network-based fix a "low accuracy" request gets can
        // wander hundreds of metres, which is what made a parked phone look like
        // it was driving.
        { enableHighAccuracy: true, maximumAge: 2_000, timeout: 20_000 },
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
        estimateRef.current = NO_ESTIMATE;
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
