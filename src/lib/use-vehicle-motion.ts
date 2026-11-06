"use client";

// Motion state for Home (docs/design/driver-hud.md §5). Watches the
// phone's GPS only while the page is visible; the reading is used for
// this one decision and is never stored or sent anywhere. No geolocation,
// permission denied, or a stale reading all report "unknown" (restricted).

import { useEffect, useRef, useState } from "react";
import type { MotionState } from "./vehicle-motion";
import { NO_ESTIMATE, motionState, stepMotion, type MotionEstimate } from "./motion-estimator";
import { NO_SUSTAINED, stepSustained, type SustainedState } from "./sustained-motion";
import { distanceM, MIN_BEARING_MOVE_M, nextHeading } from "./heading";

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
  /** The latest usable fix's reported speed, or null when none/none given. */
  speedMph: number | null;
  /** Sustained-motion / standstill tracking (Block A auto-switch); durations are read with movingForMs / stoppedForMs. */
  sustained: SustainedState;
  /** Travel direction in degrees (0 = north): the phone's heading while moving, else derived from where the truck went, else held; null before any is known. */
  headingDeg: number | null;
}

/** Motion state only (the safety decision). */
export function useVehicleMotion(): MotionState {
  return useVehicleMotionDetail().state;
}

export function useVehicleMotionDetail(): VehicleMotionDetail {
  const [state, setState] = useState<MotionState>("unknown");
  const [position, setPosition] = useState<VehiclePosition | null>(null);
  const [speedMph, setSpeedMph] = useState<number | null>(null);
  const [sustained, setSustained] = useState<SustainedState>(NO_SUSTAINED);
  const sustainedRef = useRef<SustainedState>(NO_SUSTAINED);
  const [headingDeg, setHeadingDeg] = useState<number | null>(null);
  const headingRef = useRef<{ heading: number | null; last: { lat: number; lng: number } | null }>({ heading: null, last: null });
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
          setSpeedMph(next.lastSpeedMph);
          sustainedRef.current = stepSustained(sustainedRef.current, {
            atMs: now,
            speedMph: next.lastSpeedMph,
            estimator: motionState(next, now),
          });
          setSustained(sustainedRef.current);
          const here = { lat: fix.coords.latitude, lng: fix.coords.longitude };
          const h = nextHeading({
            previous: headingRef.current.last,
            current: here,
            reportedDeg: fix.coords.heading,
            speedMph: next.lastSpeedMph,
            held: headingRef.current.heading,
          });
          // The 'previous' point only advances once the truck has really moved, so a standstill's wobble never builds a bearing.
          const last = headingRef.current.last;
          const moved = last === null || distanceM(last, here) >= MIN_BEARING_MOVE_M;
          headingRef.current = { heading: h, last: moved ? here : headingRef.current.last };
          setHeadingDeg(h);
          // A poor fix leaves the estimate untouched; the position shown is the
          // estimate's (pinned while parked), not the raw wobbling reading.
          const shown = next.displayPoint ?? { lat: fix.coords.latitude, lng: fix.coords.longitude };
          setPosition({ lat: shown.lat, lng: shown.lng, accuracyM: fix.coords.accuracy, atMs: now });
          evaluate();
        },
        () => {
          estimateRef.current = NO_ESTIMATE;
          sustainedRef.current = NO_SUSTAINED;
          setSustained(NO_SUSTAINED);
          headingRef.current = { heading: null, last: null };
          setHeadingDeg(null);
          setPosition(null);
          setSpeedMph(null);
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
        sustainedRef.current = NO_SUSTAINED;
        setSustained(NO_SUSTAINED);
        headingRef.current = { heading: null, last: null };
        setHeadingDeg(null);
        setPosition(null);
        setSpeedMph(null);
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

  return { state, position, speedMph, sustained, headingDeg };
}
