// Smooth truck motion for Drive Mode (audit-fix B7, 2026-11-18).
//
// A GPS fix arrives about once a second, and a truck that jumps from
// fix to fix reads as pinging down the road. This glides the truck
// between fixes instead: the displayed point interpolates ALONG the
// route geometry (miles along the line, not a straight chord across
// a curve) from the last fix toward the newest one, and holds at the
// newest fix when it gets there. No dead reckoning, ever — the glide
// never runs past the latest real fix, and when the truck is off the
// planned line it falls back to a straight lerp between the two
// fixes, which is still smoother than a jump.
//
// Cheap on a phone by design: the projection math runs once per fix
// (not per frame), each animation frame is one walk along the
// polyline, and the displayed fix only re-renders about five times
// a second — the decimals on the map tick, the tree does not churn.

import { useEffect, useRef, useState } from "react";
import { haversineMiles, pointAlongRoute, type LatLng } from "./smart-path";
import { routeProgress } from "./route-progress";
import type { DriveFix } from "./drive";

/** How often the gliding fix re-renders (ms) — fast enough to see the decimals tick, slow enough to stay cheap. */
export const SMOOTHED_FIX_TICK_MS = 200;

/** Miles along the route for a point, or null when it is not on the line. */
export function milesAlongRoute(point: LatLng, geometry: LatLng[]): number | null {
  const progress = routeProgress(point, geometry);
  return progress && progress.onRoute ? progress.milesDone : null;
}

/** Straight-line blend between two points (the off-route fallback). */
export function lerpPoint(a: LatLng, b: LatLng, t: number): LatLng {
  const clamped = Math.max(0, Math.min(1, t));
  return {
    lat: a.lat + (b.lat - a.lat) * clamped,
    lng: a.lng + (b.lng - a.lng) * clamped,
  };
}

/**
 * The point `t` of the way from `fromMiles` to `toMiles` along the
 * route. Null miles (off route) fall back to a straight lerp between
 * the two fix points; null geometry returns null.
 */
export function interpolateAlongRoute(
  geometry: LatLng[],
  fromPoint: LatLng,
  toPoint: LatLng,
  fromMiles: number | null,
  toMiles: number | null,
  t: number,
): LatLng | null {
  const clamped = Math.max(0, Math.min(1, t));
  if (geometry.length < 2) return null;
  if (fromMiles === null || toMiles === null) return lerpPoint(fromPoint, toPoint, clamped);
  let total = 0;
  for (let i = 1; i < geometry.length; i++) total += haversineMiles(geometry[i - 1]!, geometry[i]!);
  if (total <= 0) return lerpPoint(fromPoint, toPoint, clamped);
  const miles = fromMiles + (toMiles - fromMiles) * clamped;
  return pointAlongRoute(geometry, Math.max(0, Math.min(1, miles / total)));
}

interface GlideAnchor {
  from: LatLng;
  to: LatLng;
  fromMiles: number | null;
  toMiles: number | null;
  target: DriveFix;
  startedAtMs: number;
  durationMs: number;
}

/** A gap this long means the truck was not being watched — the glide
 * snaps to the new fix instead of gliding across town from a stale point. */
const GLIDE_MAX_GAP_MS = 30_000;

/**
 * The fix to show on the map: glides from the previous fix toward
 * the newest one while rolling, and holds at the newest fix. When
 * smoothing is off (parked, preview, no fix yet) the fix passes
 * through untouched. The glide never extrapolates past the newest
 * real fix — when the animation ends the truck sits exactly on it.
 *
 * State updates happen only inside the animation-frame callback
 * (the sanctioned shape for subscribing to an external clock); the
 * effects only start and stop the loop. The loop stops itself at
 * the newest fix, so a parked truck costs no frames.
 */
export function useSmoothedFix(
  fix: DriveFix | null,
  geometry: LatLng[],
  active: boolean,
): DriveFix | null {
  const [displayed, setDisplayed] = useState<DriveFix | null>(fix);
  const displayedRef = useRef<DriveFix | null>(fix);
  const anchorRef = useRef<GlideAnchor | null>(null);
  const geometryRef = useRef(geometry);
  const lastSetRef = useRef(0);

  useEffect(() => {
    geometryRef.current = geometry;
  }, [geometry]);

  // The glide loop: one rAF chain per fix, ~5 state updates a
  // second, and it stops itself at the newest fix. A new fix
  // restarts the chain from the currently displayed point.
  useEffect(() => {
    if (!active || !fix) return;
    let raf = 0;
    let cancelled = false;
    const step = (nowMs: number) => {
      if (cancelled) return;
      const target = fix;
      const prev = displayedRef.current;
      if (!prev) {
        // Nothing to glide from (first fix) — sit on it.
        displayedRef.current = target;
        setDisplayed(target);
        anchorRef.current = null;
        return;
      }
      // Already there (a mid-glide fix carries the target's atMs, so
      // this is a POINT comparison, never a timestamp one).
      if (prev.point.lat === target.point.lat && prev.point.lng === target.point.lng) {
        anchorRef.current = null;
        return;
      }
      if (target.atMs - prev.atMs > GLIDE_MAX_GAP_MS) {
        // Not watched for a while — snap, never glide across town.
        displayedRef.current = target;
        setDisplayed(target);
        anchorRef.current = null;
        return;
      }
      let anchor = anchorRef.current;
      if (!anchor || anchor.target.atMs !== target.atMs) {
        anchor = {
          from: prev.point,
          to: target.point,
          fromMiles: milesAlongRoute(prev.point, geometryRef.current),
          toMiles: milesAlongRoute(target.point, geometryRef.current),
          target,
          startedAtMs: nowMs,
          durationMs: Math.max(400, Math.min(5000, target.atMs - prev.atMs || 1000)),
        };
        anchorRef.current = anchor;
      }
      const t = (nowMs - anchor.startedAtMs) / anchor.durationMs;
      if (t >= 1) {
        anchorRef.current = null;
        displayedRef.current = anchor.target;
        setDisplayed(anchor.target);
        return;
      }
      if (nowMs - lastSetRef.current >= SMOOTHED_FIX_TICK_MS) {
        lastSetRef.current = nowMs;
        const point = interpolateAlongRoute(
          geometryRef.current,
          anchor.from,
          anchor.to,
          anchor.fromMiles,
          anchor.toMiles,
          t,
        );
        if (point) {
          const next = { ...anchor.target, point };
          displayedRef.current = next;
          setDisplayed(next);
        }
      }
      raf = requestAnimationFrame(step);
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
