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

/**
 * How the camera closes on a maneuver (owner 2026-11-18: "closer in
 * for tight exits, farther out for big highway ones"). A highway exit
 * or ramp is seen coming from ~4.5 miles (the owner's example) and
 * needs only a gentle zoom — the ramp is long; a tight street turn
 * starts ~1.5 miles out and zooms closer, since the turn itself is
 * small. Straight-ahead and arrival: no profile, no zoom, ever.
 */
export interface ManeuverZoomProfile {
  kind: "exit" | "turn";
  /** The approach (zoom + early call-out) starts this far out. */
  startMiles: number;
  /** Inside this, the zoom holds at its closest. */
  closeMiles: number;
  /** Extra zoom at the start of the approach, and close in. */
  boostFar: number;
  boostClose: number;
}

export const EXIT_ZOOM: ManeuverZoomProfile = { kind: "exit", startMiles: 4.5, closeMiles: 0.5, boostFar: 0.4, boostClose: 1.6 };
export const TURN_ZOOM: ManeuverZoomProfile = { kind: "turn", startMiles: 1.5, closeMiles: 0.2, boostFar: 0.8, boostClose: 2.4 };

/** Exit / ramp wording from the routing provider (OSRM / Valhalla / GraphHopper style). */
const EXIT_WORDS = /\b(exit|ramp|off-ramp|on-ramp|motorway|merge onto|keep (left|right) (at|onto|to stay))\b/i;
/** A turn ONTO a highway (I-, US-, SR-, Hwy) is a big-road maneuver: the owner's own example, "In 4.4 miles, turn right…". */
const ONTO_HIGHWAY = /\bonto\s+(I-|US[- ]|SR[- ]|State (Route|Road)|Hwy|Highway|Interstate)/i;

export function maneuverZoomProfile(instruction: string, direction: ManeuverDirection): ManeuverZoomProfile | null {
  if (direction === "arrive") return null;
  if (/\bstay on\b/i.test(instruction) || /^continue\b/i.test(instruction)) return null;
  if (EXIT_WORDS.test(instruction) || ((direction === "left" || direction === "right") && ONTO_HIGHWAY.test(instruction))) return EXIT_ZOOM;
  if (direction === "left" || direction === "right" || direction === "uturn") return TURN_ZOOM;
  return null;
}

/** Only turns and exits get the zoom — straight-ahead never does. */
export function isTurnManeuver(direction: ManeuverDirection, instruction = ""): boolean {
  return maneuverZoomProfile(instruction, direction) !== null;
}

function smoothstep(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * (3 - 2 * clamped);
}

export interface ManeuverZoomTargetInput {
  milesAway: number;
  direction: ManeuverDirection;
  /** The provider's instruction text (tells an exit from a street turn). */
  instruction?: string;
  /** The normal follow zoom the map eases back out to. */
  baseZoom: number;
}

/**
 * The zoom the camera should ease toward for the next maneuver.
 * The normal follow zoom for straight-ahead, arrival, or anything
 * farther out than the approach — so the camera eases back out on
 * its own once the turn is passed.
 */
export function maneuverZoomTarget({ milesAway, direction, instruction = "", baseZoom }: ManeuverZoomTargetInput): number {
  const profile = maneuverZoomProfile(instruction, direction);
  if (!profile) return baseZoom;
  if (!Number.isFinite(milesAway) || milesAway < 0) return baseZoom;
  if (milesAway > profile.startMiles) return baseZoom;
  const t = smoothstep((profile.startMiles - milesAway) / (profile.startMiles - profile.closeMiles));
  return baseZoom + profile.boostFar + (profile.boostClose - profile.boostFar) * t;
}
