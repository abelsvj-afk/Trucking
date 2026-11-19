// Maneuver zoom for Drive Mode (audit-fix B7, 2026-11-18). Pure.
//
// As the driver approaches an exit or turn — never straight-ahead —
// the map zooms in smoothly starting a few miles out (the owner's
// example: about 4.5 miles), fitting the whole turn on screen, then
// zooms a little more as he gets closer so he never misses it, and
// eases back out to the normal tilted view after passing. This only
// decides the TARGET zoom; MapLibre's easeTo does the easing between
// values, so passing and straight-ahead maneuvers glide back out
// instead of snapping.
//
// Zoom levels are MapLibre's: each +1 halves the ground width on
// screen. At the usual follow zoom (15) a phone shows roughly a
// mile and a half across; +2 close in shows the turn itself at
// street level without losing the road that follows it.

import type { maneuverDirection } from "./drive";

export type ManeuverDirection = ReturnType<typeof maneuverDirection>;

/** The approach starts this far out (the owner's ~4.5-mile example). */
export const MANEUVER_ZOOM_START_MILES = 4.5;
/** Inside this, the zoom holds at its closest — the turn is on screen. */
export const MANEUVER_ZOOM_CLOSE_MILES = 0.5;
/** Extra zoom at the start of the approach. */
export const MANEUVER_ZOOM_BOOST_FAR = 0.5;
/** Extra zoom close in. */
export const MANEUVER_ZOOM_BOOST_CLOSE = 2;

/** Only turns and exits get the zoom — straight-ahead never does. */
export function isTurnManeuver(direction: ManeuverDirection): boolean {
  return direction === "left" || direction === "right" || direction === "uturn";
}

function smoothstep(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * (3 - 2 * clamped);
}

export interface ManeuverZoomTargetInput {
  milesAway: number;
  direction: ManeuverDirection;
  /** The normal follow zoom the map eases back out to. */
  baseZoom: number;
}

/**
 * The zoom the camera should ease toward for the next maneuver.
 * The normal follow zoom for straight-ahead, arrival, or anything
 * farther out than the approach — so the camera eases back out on
 * its own once the turn is passed.
 */
export function maneuverZoomTarget({
  milesAway,
  direction,
  baseZoom,
}: ManeuverZoomTargetInput): number {
  if (!isTurnManeuver(direction)) return baseZoom;
  if (!Number.isFinite(milesAway) || milesAway < 0) return baseZoom;
  if (milesAway > MANEUVER_ZOOM_START_MILES) return baseZoom;
  const t = smoothstep(
    (MANEUVER_ZOOM_START_MILES - milesAway) /
      (MANEUVER_ZOOM_START_MILES - MANEUVER_ZOOM_CLOSE_MILES),
  );
  return (
    baseZoom +
    MANEUVER_ZOOM_BOOST_FAR +
    (MANEUVER_ZOOM_BOOST_CLOSE - MANEUVER_ZOOM_BOOST_FAR) * t
  );
}
