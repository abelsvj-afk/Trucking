// Rerouting for Drive Mode (audit D4, 2026-11-05). Pure.
// Three decisions live here, each testable on its own:
//   1. am I OFF the planned line? (distance to the polyline, sustained,
//      only on a fix good enough to judge by);
//   2. what do I ask the route-check for? (from HERE to the destination,
//      the pickup already behind me);
//   3. may the answer replace the plan? ONLY if the provider says the new
//      route is truck-checked. A car route never silently replaces a truck
//      route - the old plan stays and he is told plainly.

import type { DrivePlanSnapshot } from "@/lib/drive";
import { buildDrivePlan } from "@/lib/drive";
import type { RouteCheckResponse } from "@/types/smart-path";

type LatLng = { lat: number; lng: number };

/** Farther than this from the planned line counts as off it. */
export const OFF_ROUTE_MILES = 0.3;
/** ...for this long, continuously (a wide turn or a bad fix is not a detour). */
export const OFF_ROUTE_HOLD_MS = 25_000;
/** A fix worse than this can't say whether he is on the line. */
export const MAX_FIX_ACCURACY_M = 100;
/** Never ask for a new route more often than this. */
export const MIN_REROUTE_INTERVAL_MS = 120_000;

const EARTH_RADIUS_MILES = 3958.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Distance in miles from a point to the nearest part of a polyline (equirectangular, per segment). */
export function distanceToRouteMiles(point: LatLng, geometry: LatLng[]): number | null {
  if (geometry.length === 0) return null;
  const cosLat = Math.cos(toRad(point.lat));
  // local planar coordinates in miles, with the point at the origin
  const toXY = (p: LatLng) => ({
    x: toRad(p.lng - point.lng) * cosLat * EARTH_RADIUS_MILES,
    y: toRad(p.lat - point.lat) * EARTH_RADIUS_MILES,
  });
  const first = toXY(geometry[0]!);
  if (geometry.length === 1) return Math.hypot(first.x, first.y);
  let best = Infinity;
  let prev = first;
  for (let i = 1; i < geometry.length; i++) {
    const cur = toXY(geometry[i]!);
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    const len2 = dx * dx + dy * dy;
    // projection of the origin onto the segment, clamped to it
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(prev.x * dx + prev.y * dy) / len2));
    best = Math.min(best, Math.hypot(prev.x + t * dx, prev.y + t * dy));
    prev = cur;
  }
  return best;
}

export interface OffRouteState {
  /** When he first went beyond the threshold in this episode; null while on the line. */
  offSinceMs: number | null;
  /** The off-route announcement for this episode has been made. */
  announced: boolean;
}

export const INITIAL_OFF_ROUTE: OffRouteState = { offSinceMs: null, announced: false };

export interface OffRouteStep {
  state: OffRouteState;
  /** He has been off the line long enough to act on. */
  offRoute: boolean;
  /** True exactly once per episode - the moment to say it. */
  justDetected: boolean;
}

/**
 * A fix with no usable position or with poor accuracy says nothing either
 * way: the episode neither starts nor resets (a tunnel or a bad fix must not
 * trigger - or cancel - a reroute).
 */
export function stepOffRoute(
  state: OffRouteState,
  input: { distanceMiles: number | null; accuracyM: number | null; nowMs: number },
): OffRouteStep {
  const { distanceMiles, accuracyM, nowMs } = input;
  const unusable =
    distanceMiles === null || accuracyM === null || !Number.isFinite(distanceMiles) || accuracyM > MAX_FIX_ACCURACY_M;
  if (unusable) {
    return { state, offRoute: state.offSinceMs !== null && nowMs - state.offSinceMs >= OFF_ROUTE_HOLD_MS, justDetected: false };
  }
  if (distanceMiles <= OFF_ROUTE_MILES) {
    return { state: INITIAL_OFF_ROUTE, offRoute: false, justDetected: false };
  }
  const offSinceMs = state.offSinceMs ?? nowMs;
  const offRoute = nowMs - offSinceMs >= OFF_ROUTE_HOLD_MS;
  const justDetected = offRoute && !state.announced;
  return { state: { offSinceMs, announced: state.announced || justDetected }, offRoute, justDetected };
}

export interface RerouteRequest {
  load_id: string;
  depart_at: string;
  start_point: LatLng;
  start_at: string;
  already_picked_up: true;
}

export function buildRerouteRequest(plan: DrivePlanSnapshot, from: LatLng, nowIso: string): RerouteRequest {
  return { load_id: plan.loadId, depart_at: nowIso, start_point: from, start_at: nowIso, already_picked_up: true };
}

/** Whether a reroute may be requested now (not too soon after the last one). */
export function mayRequestReroute(lastRequestMs: number | null, nowMs: number): boolean {
  return lastRequestMs === null || nowMs - lastRequestMs >= MIN_REROUTE_INTERVAL_MS;
}

export type RerouteOutcome =
  | { ok: true; plan: DrivePlanSnapshot; milesToGo: number }
  | { ok: false; reason: "car-route" | "no-route" };

/** The acceptance rule: only a provider-confirmed truck route may replace the plan. */
export function evaluateRerouteResult(result: RouteCheckResponse | null, now: Date): RerouteOutcome {
  if (!result || !result.route || !Array.isArray(result.route.geometry) || result.route.geometry.length < 2) {
    return { ok: false, reason: "no-route" };
  }
  if (!result.route.truckLegal) return { ok: false, reason: "car-route" };
  const plan = { ...buildDrivePlan(result, now), originLabel: "Your position at the reroute" };
  return { ok: true, plan, milesToGo: plan.totalMiles };
}

// ---- words (spoken and shown) ------------------------------------------------

export const REROUTE_COPY = {
  offRoute: "You're off the planned route. Getting a new route.",
  failedCar:
    "I couldn't get a truck-checked route from here, so I'm not switching. Use the truck's own navigation until you're back on the line.",
  failedNoRoute: "I couldn't get a new route just now. Use the truck's own navigation until you're back on the line.",
  working: "Getting a new route from where you are…",
} as const;

export function reroutedSpeech(milesToGo: number): string {
  return `New truck-checked route. ${Math.round(milesToGo)} miles to go.`;
}
