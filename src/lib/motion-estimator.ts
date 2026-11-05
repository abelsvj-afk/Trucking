// Is the vehicle really moving? (owner report 2026-11-05: parked, the GPS
// "fidgets" and the app locks as if driving.) Pure.
//
// The phone's raw readings are noisy: a parked phone drifts a few to a few
// dozen metres, reports small non-zero speeds, spikes now and then, and some
// phones report NO speed at all while standing still. Treating each reading
// on its own made a parked truck look like it was creeping - and treating a
// missing speed as "unknown" locked the app while parked.
//
// The fix is the "bubble" Google Maps effectively uses: once the vehicle has
// been seen stopped, remember where (the anchor) and ignore wander that stays
// inside a bubble around it - radius = at least BUBBLE_MIN_M, and 1.5x the
// fix's reported accuracy. The vehicle counts as MOVING only on evidence that
// survives the bubble:
//   - two consecutive fixes outside the bubble, or
//   - two consecutive fixes reporting clearly-moving speed (> CONFIRM_MPH), or
//   - one good-accuracy fix reporting clearly-moving speed (> FAST_MPH).
// A single spike inside the bubble changes nothing. Safety is unchanged in
// kind: nothing unlocks without POSITIVE evidence of a stop (steady fixes
// inside the bubble, long enough), a poor or stale fix says nothing, and the
// existing 10 s settle still has to hold before the fuller screen unlocks.

import { haversineMiles } from "./live-motion";
import { FIX_STALE_MS, STOP_SETTLE_MS, type MotionState } from "./vehicle-motion";

export const BUBBLE_MIN_M = 30;
export const BUBBLE_ACCURACY_FACTOR = 1.5;
/** A fix worse than this can't support a position-based conclusion. */
export const MAX_USABLE_ACCURACY_M = 100;
/** Two consecutive fixes above this are moving even inside the bubble. */
export const CONFIRM_MPH = 8;
/** One good fix above this is moving at once (a truck, not a wobble). */
export const FAST_MPH = 15;
/** Below this the vehicle is stopped for speed purposes. */
export const STOPPED_BELOW_MPH = 5;

const METERS_PER_MILE = 1609.344;

export interface MotionFix {
  lat: number;
  lng: number;
  accuracyM: number;
  atMs: number;
  /** The phone's own speed, or null when it gave none. */
  speedMph: number | null;
}

export interface MotionEstimate {
  /** Where the vehicle was last seen to settle; the bubble is drawn around it. */
  anchor: { lat: number; lng: number; accuracyM: number } | null;
  /** When the current uninterrupted stop began. */
  stoppedSinceMs: number | null;
  moving: boolean;
  /** Consecutive fixes outside the bubble / reporting clearly-moving speed. */
  outsideCount: number;
  fastCount: number;
  lastGoodFixMs: number | null;
  /** The point to DRAW: pinned to the anchor while parked, so the icon doesn't jitter. */
  displayPoint: { lat: number; lng: number } | null;
}

export const NO_ESTIMATE: MotionEstimate = {
  anchor: null,
  stoppedSinceMs: null,
  moving: false,
  outsideCount: 0,
  fastCount: 0,
  lastGoodFixMs: null,
  displayPoint: null,
};

function bubbleRadiusM(anchorAccuracyM: number, fixAccuracyM: number): number {
  return Math.max(BUBBLE_MIN_M, BUBBLE_ACCURACY_FACTOR * Math.max(anchorAccuracyM, fixAccuracyM));
}

function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return haversineMiles(a, b) * METERS_PER_MILE;
}

export function stepMotion(prev: MotionEstimate, fix: MotionFix): MotionEstimate {
  // A poor fix is no evidence either way: it neither starts nor ends a stop.
  if (!Number.isFinite(fix.accuracyM) || fix.accuracyM > MAX_USABLE_ACCURACY_M) return prev;

  const speed = fix.speedMph !== null && Number.isFinite(fix.speedMph) && fix.speedMph >= 0 ? fix.speedMph : null;
  const here = { lat: fix.lat, lng: fix.lng };

  // First good fix: we know where he is, not yet whether he is stopped.
  if (!prev.anchor) {
    const stopped = speed !== null && speed < STOPPED_BELOW_MPH;
    return {
      anchor: { ...here, accuracyM: fix.accuracyM },
      stoppedSinceMs: stopped ? fix.atMs : null,
      moving: speed !== null && speed >= STOPPED_BELOW_MPH,
      outsideCount: 0,
      fastCount: 0,
      lastGoodFixMs: fix.atMs,
      displayPoint: here,
    };
  }

  const radius = bubbleRadiusM(prev.anchor.accuracyM, fix.accuracyM);
  const outside = metersBetween(prev.anchor, here) > radius;
  // Outside the bubble with an explicit LOW speed is slow drift, not departure:
  // the bubble follows it and nothing counts toward "moving".
  const slowDrift = outside && speed !== null && speed < STOPPED_BELOW_MPH;
  const outsideCount = outside && !slowDrift ? prev.outsideCount + 1 : 0;
  const clearlyMoving = speed !== null && speed > CONFIRM_MPH;
  const fastCount = clearlyMoving ? prev.fastCount + 1 : 0;
  const movingEvidence =
    outsideCount >= 2 || fastCount >= 2 || (speed !== null && speed > FAST_MPH);

  if (movingEvidence) {
    // Moving: the anchor follows the vehicle so the next stop gets its own bubble.
    return {
      anchor: { ...here, accuracyM: fix.accuracyM },
      stoppedSinceMs: null,
      moving: true,
      outsideCount,
      fastCount,
      lastGoodFixMs: fix.atMs,
      displayPoint: here,
    };
  }

  if (prev.moving) {
    // Was moving: a stop needs a reported low speed (or, with no speed given,
    // no displacement since the last anchor) before a new bubble forms here.
    const lowSpeed = speed !== null ? speed < STOPPED_BELOW_MPH : !outside;
    if (!lowSpeed) {
      return { ...prev, anchor: { ...here, accuracyM: fix.accuracyM }, outsideCount, fastCount, lastGoodFixMs: fix.atMs, displayPoint: here };
    }
    return {
      anchor: { ...here, accuracyM: fix.accuracyM },
      stoppedSinceMs: fix.atMs,
      moving: false,
      outsideCount: 0,
      fastCount: 0,
      lastGoodFixMs: fix.atMs,
      displayPoint: here,
    };
  }

  if (slowDrift && !prev.moving) {
    return {
      ...prev,
      anchor: { ...here, accuracyM: fix.accuracyM },
      stoppedSinceMs: prev.stoppedSinceMs ?? fix.atMs,
      outsideCount: 0,
      fastCount: 0,
      lastGoodFixMs: fix.atMs,
      displayPoint: here,
    };
  }

  // Not moving and no evidence of leaving: inside the bubble the vehicle is
  // stopped (wander, spikes and a missing speed all change nothing); a lone
  // fix outside the bubble is held back until a second one confirms it.
  return {
    ...prev,
    stoppedSinceMs: prev.stoppedSinceMs ?? fix.atMs,
    outsideCount,
    fastCount,
    lastGoodFixMs: fix.atMs,
    displayPoint: outside ? prev.displayPoint ?? here : prev.anchor ? { lat: prev.anchor.lat, lng: prev.anchor.lng } : here,
  };
}

/**
 * The safety state at a moment. Fail closed: no good fix, or one older than
 * FIX_STALE_MS, is "unknown"; moving is moving; "stopped" counts only once it
 * has held STOP_SETTLE_MS (until then the screen stays restricted).
 */
export function motionState(est: MotionEstimate, nowMs: number): MotionState {
  if (est.lastGoodFixMs === null || nowMs - est.lastGoodFixMs > FIX_STALE_MS) return "unknown";
  if (est.moving) return "moving";
  if (est.stoppedSinceMs === null) return "unknown";
  return nowMs - est.stoppedSinceMs >= STOP_SETTLE_MS ? "stopped" : "moving";
}
