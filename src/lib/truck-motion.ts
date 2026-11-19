// Smooth driving for the 3D truck (owner 2026-11-19: "the 3d semi
// truck with moving tires as it smoothly drives"). GPS fixes arrive
// every few seconds; drawing the truck only AT each fix makes it
// jump. This glides the drawn pose from where it is now to the new
// fix over about the time between fixes, turns the heading the short
// way round, and rolls the tires by the distance actually covered.
//
// Pure (clock passed in) so it is unit-tested without a GL context.
// The truck-map-layer asks for a repaint only while a glide is in
// progress — a parked truck costs no frames.

import { haversineMiles, type LatLng } from "./smart-path";

const METERS_PER_MILE = 1609.344;
/** Tire radius in the model (truck-model.ts wheels are r 0.5 m). */
export const TIRE_RADIUS_M = 0.5;
/** Glide time bounds. Fixes come ~1-5 s apart; a long gap still glides in at most 2.5 s. */
const MIN_GLIDE_MS = 300;
const MAX_GLIDE_MS = 2_500;
/** A jump farther than this is a teleport (first fix, app resumed): snap, don't glide across the map. */
const SNAP_DISTANCE_M = 2_000;

export interface TruckPose {
  position: LatLng;
  headingDeg: number;
}

export interface TruckMotion {
  from: TruckPose;
  to: TruckPose;
  startMs: number;
  durationMs: number;
  lastFixMs: number;
  /** Tire roll, radians. */
  wheelAngle: number;
  /** The pose drawn last frame (where the next glide starts from). */
  drawn: TruckPose;
}

export interface TruckFrame {
  pose: TruckPose;
  wheelAngle: number;
  /** True while the truck is still gliding — the layer repaints again. */
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

function samePose(a: TruckPose, b: TruckPose): boolean {
  return a.position.lat === b.position.lat && a.position.lng === b.position.lng && a.headingDeg === b.headingDeg;
}

/**
 * Feed the latest fix. Returns the same motion when nothing changed
 * (the fix ref is re-read every frame), a new glide when it moved.
 */
export function feedFix(motion: TruckMotion | null, fix: TruckPose, nowMs: number): TruckMotion {
  if (!motion) {
    return { from: fix, to: fix, startMs: nowMs, durationMs: 0, lastFixMs: nowMs, wheelAngle: 0, drawn: fix };
  }
  if (samePose(motion.to, fix)) return motion;
  const meters = haversineMiles(motion.drawn.position, fix.position) * METERS_PER_MILE;
  if (meters > SNAP_DISTANCE_M) {
    return { ...motion, from: fix, to: fix, startMs: nowMs, durationMs: 0, lastFixMs: nowMs, drawn: fix };
  }
  const gap = nowMs - motion.lastFixMs;
  const durationMs = Math.min(MAX_GLIDE_MS, Math.max(MIN_GLIDE_MS, gap));
  return { ...motion, from: motion.drawn, to: fix, startMs: nowMs, durationMs, lastFixMs: nowMs };
}

/** The pose to draw now; advances the tire roll by the ground covered since the last frame. */
export function sampleMotion(motion: TruckMotion, nowMs: number): { motion: TruckMotion; frame: TruckFrame } {
  const t = motion.durationMs <= 0 ? 1 : Math.min(1, Math.max(0, (nowMs - motion.startMs) / motion.durationMs));
  // Ease out: the truck settles onto the fix instead of stopping dead.
  const e = 1 - (1 - t) * (1 - t);
  const pose: TruckPose = {
    position: {
      lat: lerp(motion.from.position.lat, motion.to.position.lat, e),
      lng: lerp(motion.from.position.lng, motion.to.position.lng, e),
    },
    headingDeg: lerpHeading(motion.from.headingDeg, motion.to.headingDeg, e),
  };
  const rolled = haversineMiles(motion.drawn.position, pose.position) * METERS_PER_MILE;
  const wheelAngle = (motion.wheelAngle + rolled / TIRE_RADIUS_M) % (Math.PI * 2);
  return {
    motion: { ...motion, drawn: pose, wheelAngle },
    frame: { pose, wheelAngle, animating: t < 1 },
  };
}
