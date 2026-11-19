// The gliding fix the Drive page's NUMBERS read (audit-fix B7,
// 2026-11-18; reconciled 2026-11-19 into ONE motion system).
//
// The glide itself lives in truck-motion.ts — the same code the 3D
// truck layer draws with — so the miles on screen and the truck on
// the map move together. This hook only runs that motion against the
// plan's road-miles line (route-measure.ts) and re-renders about five
// times a second while the truck glides: enough to see the decimals
// tick (7.8, 7.7…), cheap enough for a phone. It stops itself at the
// newest fix, so a parked truck costs no frames, and it never runs
// past the newest real fix (no dead reckoning).

import { useEffect, useRef, useState } from "react";
import type { RouteMeasure } from "./route-measure";
import { feedFix, sampleMotion, type TruckMotion } from "./truck-motion";
import type { DriveFix } from "./drive";

/** How often the gliding fix re-renders (ms) — fast enough to see the decimals tick, slow enough to stay cheap. */
export const SMOOTHED_FIX_TICK_MS = 200;

/**
 * The fix to show the numbers from: glides from the previous fix
 * toward the newest one while rolling, and holds at the newest fix.
 * When smoothing is off (parked, preview, no fix yet) the fix passes
 * through untouched.
 */
export function useSmoothedFix(fix: DriveFix | null, measure: RouteMeasure | null, active: boolean): DriveFix | null {
  const [displayed, setDisplayed] = useState<DriveFix | null>(fix);
  const motionRef = useRef<TruckMotion | null>(null);
  const measureRef = useRef(measure);

  useEffect(() => {
    measureRef.current = measure;
  }, [measure]);

  useEffect(() => {
    if (!active || !fix) {
      motionRef.current = null;
      return;
    }
    let raf = 0;
    let cancelled = false;
    let lastSet = 0;
    motionRef.current = feedFix(
      motionRef.current,
      { position: fix.point, headingDeg: fix.headingDeg },
      performance.now(),
      measureRef.current,
    );
    const step = (nowMs: number) => {
      if (cancelled || !motionRef.current) return;
      const { motion, frame } = sampleMotion(motionRef.current, nowMs);
      motionRef.current = motion;
      if (!frame.animating || nowMs - lastSet >= SMOOTHED_FIX_TICK_MS) {
        lastSet = nowMs;
        setDisplayed({ ...fix, point: frame.pose.position });
      }
      if (frame.animating) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [active, fix]);

  if (!active) return fix;
  if (!fix) return null;
  return displayed ?? fix;
}
