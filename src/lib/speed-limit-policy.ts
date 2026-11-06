// When to ask for the posted limit, and when a returned limit may still be shown (Block C).
// Pure. A limit belongs to a PLACE: once the truck has moved on, the old limit is hidden
// (never carried onto the next road), and a stale answer is hidden too. No data = no badge.

import { distanceM } from "./heading";
import type { LatLng } from "./smart-path";

/** Ask again after the truck has moved this far. */
export const REQUERY_DISTANCE_M = 60;
/** ...or after this long while moving, whichever comes first. */
export const REQUERY_AFTER_MS = 45_000;
/** Never ask more often than this. */
export const MIN_GAP_MS = 8_000;
/** A limit older than this is not shown. */
export const LIMIT_FRESH_MS = 120_000;
/** A limit is not shown once the truck is this far from where it was looked up. */
export const LIMIT_VALID_RADIUS_M = 200;

export interface LimitLookup {
  atMs: number;
  point: LatLng;
}

export function shouldQuerySpeedLimit(last: LimitLookup | null, nowMs: number, position: LatLng, moving: boolean): boolean {
  if (!last) return true;
  const since = nowMs - last.atMs;
  if (since < MIN_GAP_MS) return false;
  if (!moving) return false; // parked: the answer for this spot does not change
  return distanceM(last.point, position) >= REQUERY_DISTANCE_M || since >= REQUERY_AFTER_MS;
}

export function limitIsShowable(
  result: { limitMph: number | null; lookup: LimitLookup } | null,
  nowMs: number,
  position: LatLng | null,
): number | null {
  if (!result || result.limitMph === null || !position) return null;
  if (nowMs - result.lookup.atMs > LIMIT_FRESH_MS) return null;
  if (distanceM(result.lookup.point, position) > LIMIT_VALID_RADIUS_M) return null;
  return result.limitMph;
}
