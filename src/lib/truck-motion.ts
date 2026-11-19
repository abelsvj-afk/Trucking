// The ONE motion system for the truck on the map (owner 2026-11-18:
// "the truck glides smoothly ... the front always points in the
// direction of travel"; 2026-11-19: one motion system, not two).
//
// GPS fixes arrive every second or few; drawing the truck only AT
// each fix makes it jump. This glides the drawn pose from where it
// is now to the newest fix over about the time between fixes:
// - ALONG THE ROAD when both ends are on the route line (miles
//   along the line are interpolated, so the truck follows a curve
//   instead of cutting across it), straight between the two points
//   otherwise;
// - the nose points the way the truck is TRAVELLING: the road's own
//   direction on the route, the direction between the two fixes off
//   it, the GPS heading only when the truck has not moved;
// - it turns the short way round, never past the newest real fix
//   (no dead reckoning), snaps instead of gliding across the map on
//   a teleport, and rolls the tires by the ground covered.
//
// Used by the 3D layer (every frame, while gliding) AND by the Drive
// page's numbers (useSmoothedFix, ~5 times a second): same code, same
// fixes, so the truck on the map and the miles counting down move
// together. Pure (clock passed in) — unit-tested without a GL context.

import { haversineMiles, type LatLng } from "./smart-path";
import { bearingDeg, headingAtRoadMiles, measurePoint, pointAtRoadMiles, type RouteMeasure } from "./route-measure";

const METERS_PER_MILE = 1609.344;
/** Tire radius in the model (truck-model.ts wheels are r 0.5 m). */
export const TIRE_RADIUS_M = 0.5;
/** Glide time bounds. Fixes come ~1-5 s apart; a long gap still glides in at most 2.5 s. */
const MIN_GLIDE_MS = 300;
const MAX_GLIDE_MS = 2_500;
/** A jump farther than this is a teleport (first fix, app resumed): snap, don't glide across the map. */
const SNAP_DISTANCE_M = 2_000;
/** Moved less than this between fixes = standing still: keep the nose where it was. */
const STILL_M = 3;

export interface TruckPose {
  position: LatLng;
  headingDeg: number;
}

/** A fix as fed in: the GPS heading may be missing. */
export interface TruckFixInput {
  position: LatLng;
  headingDeg: number | null;
}

interface RouteSpan {
  measure: RouteMeasure;
  fromMiles: number;
  toMiles: number;
}

export interface TruckMotion {
  from: TruckPose;
  to: TruckPose;
  /** Set when the glide runs along the route line. */
  route: RouteSpan | null;
  startMs: number;
  durationMs: number;
  lastFixMs: number;
  /** The raw fix last fed (to tell a new fix from a re-read one). */
  lastFix: TruckFixInput;
  /** Tire roll, radians. */
  wheelAngle: number;
  /** The pose drawn last frame (where the next glide starts from). */
  drawn: TruckPose;
}

export interface TruckFrame {
  pose: TruckPose;
  wheelAngle: number;
  /** True while the truck is still gliding — the caller asks for another frame. */
  animating: boolean;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest-way turn: 350° → 10° goes through north, not all the way round. */
export function lerpHeading(a: number, b: number, t: number): number {
  const delta = ((((b - a) % 360) + 540) % 360) - 180;
  return (((a + delta * t) % 360) + 360) % 360;
}

function sameFix(a: TruckFixInput, b: TruckFixInput): boolean {
  return a.position.lat === b.position.lat && a.position.lng === b.position.lng && a.headingDeg === b.headingDeg;
}

function metersBetween(a: LatLng, b: LatLng): number {
  return haversineMiles(a, b) * METERS_PER_MILE;
}

/** The direction of travel from a → b, falling back to the GPS heading, then to the previous nose. */
function travelHeading(from: TruckPose, to: LatLng, gps: number | null): number {
  if (metersBetween(from.position, to) >= STILL_M) {
    const b = bearingDeg(from.position, to);
    if (b !== null) return b;
  }
  return gps ?? from.headingDeg;
}

/**
 * Feed the latest fix. Returns the same motion when nothing changed
 * (callers re-read the fix every frame), a new glide when it moved.
 * `measure` (optional) is the route line: with it the glide follows
 * the road.
 */
export function feedFix(
  motion: TruckMotion | null,
  fix: TruckFixInput,
  nowMs: number,
  measure: RouteMeasure | null = null,
): TruckMotion {
  if (!motion) {
    const pose = { position: fix.position, headingDeg: fix.headingDeg ?? 0 };
    return { from: pose, to: pose, route: null, startMs: nowMs, durationMs: 0, lastFixMs: nowMs, lastFix: fix, wheelAngle: 0, drawn: pose };
  }
  if (sameFix(motion.lastFix, fix)) return motion;
  const from = motion.drawn;
  if (metersBetween(from.position, fix.position) > SNAP_DISTANCE_M) {
    const pose = { position: fix.position, headingDeg: fix.headingDeg ?? from.headingDeg };
    return { ...motion, from: pose, to: pose, route: null, startMs: nowMs, durationMs: 0, lastFixMs: nowMs, lastFix: fix, drawn: pose };
  }
  let route: RouteSpan | null = null;
  let toHeading = travelHeading(from, fix.position, fix.headingDeg);
  if (measure) {
    const a = measurePoint(measure, from.position);
    const b = measurePoint(measure, fix.position);
    // Only glide along the line when both ends are on it AND the truck
    // went forward — backing up or a U-turn off the line glides straight.
    if (a?.onRoute && b?.onRoute && b.roadMiles >= a.roadMiles) {
      route = { measure, fromMiles: a.roadMiles, toMiles: b.roadMiles };
      if (b.roadMiles - a.roadMiles > 0) toHeading = headingAtRoadMiles(measure, b.roadMiles) ?? toHeading;
    }
  }
  const gap = nowMs - motion.lastFixMs;
  const durationMs = Math.min(MAX_GLIDE_MS, Math.max(MIN_GLIDE_MS, gap));
  return {
    ...motion,
    from,
    to: { position: fix.position, headingDeg: toHeading },
    route,
    startMs: nowMs,
    durationMs,
    lastFixMs: nowMs,
    lastFix: fix,
  };
}

/** The pose to draw now; advances the tire roll by the ground covered since the last frame. */
export function sampleMotion(motion: TruckMotion, nowMs: number): { motion: TruckMotion; frame: TruckFrame } {
  const t = motion.durationMs <= 0 ? 1 : Math.min(1, Math.max(0, (nowMs - motion.startMs) / motion.durationMs));
  // Ease out: the truck settles onto the fix instead of stopping dead.
  const e = 1 - (1 - t) * (1 - t);
  let position: LatLng;
  let headingDeg: number;
  if (t >= 1) {
    position = motion.to.position;
    headingDeg = motion.to.headingDeg;
  } else if (motion.route) {
    const miles = lerp(motion.route.fromMiles, motion.route.toMiles, e);
    position = pointAtRoadMiles(motion.route.measure, miles) ?? motion.to.position;
    // On the road the nose follows the road itself (a curve turns the truck through it).
    headingDeg = motion.route.toMiles > motion.route.fromMiles
      ? (headingAtRoadMiles(motion.route.measure, miles) ?? lerpHeading(motion.from.headingDeg, motion.to.headingDeg, e))
      : lerpHeading(motion.from.headingDeg, motion.to.headingDeg, e);
    // Turn into it smoothly at the start instead of snapping to the road's bearing.
    if (t < 0.25) headingDeg = lerpHeading(motion.from.headingDeg, headingDeg, t / 0.25);
  } else {
    position = { lat: lerp(motion.from.position.lat, motion.to.position.lat, e), lng: lerp(motion.from.position.lng, motion.to.position.lng, e) };
    headingDeg = lerpHeading(motion.from.headingDeg, motion.to.headingDeg, e);
  }
  const pose: TruckPose = { position, headingDeg };
  const rolled = metersBetween(motion.drawn.position, pose.position);
  const wheelAngle = (motion.wheelAngle + rolled / TIRE_RADIUS_M) % (Math.PI * 2);
  return {
    motion: { ...motion, drawn: pose, wheelAngle },
    frame: { pose, wheelAngle, animating: t < 1 },
  };
}
