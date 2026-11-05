// Smart Path intelligence, Phase 1 (docs/design/smart-path-intelligence.md §1):
// a corridor of evenly spaced points along the chosen route, each with its mile
// mark and the time he will actually be there. Pure - the later layers (regional
// fuel, weather, state rules, road work) ask "what is near THIS point at THIS time".

import { elapsedAtDrivenMinutes, haversineMiles, type LatLng, type RoutePlan } from "./smart-path";

export const DEFAULT_CORRIDOR_SPACING_MILES = 10;

export interface CorridorPoint {
  index: number;
  lat: number;
  lng: number;
  /** Miles from the start along the route geometry. */
  mileFromStart: number;
  /** 0-1 of the route length. */
  fraction: number;
}

export interface Corridor {
  totalMiles: number;
  spacingMiles: number;
  points: CorridorPoint[];
}

export type CorridorResult = { ok: true; corridor: Corridor } | { ok: false; reason: string };

/** Walks the geometry and drops a point every `spacingMiles` (always including the first and last). */
export function buildCorridor(geometry: LatLng[], spacingMiles: number = DEFAULT_CORRIDOR_SPACING_MILES): CorridorResult {
  if (geometry.length < 2) return { ok: false, reason: "The route has fewer than two points, so there is no corridor to check." };
  if (!(spacingMiles > 0)) return { ok: false, reason: "Corridor spacing must be positive." };

  const cumulative: number[] = [0];
  for (let i = 1; i < geometry.length; i++) {
    cumulative.push(cumulative[i - 1]! + haversineMiles(geometry[i - 1]!, geometry[i]!));
  }
  const totalMiles = cumulative[cumulative.length - 1]!;
  if (totalMiles <= 0) return { ok: false, reason: "The route has no length, so there is no corridor to check." };

  const at = (mile: number): LatLng => {
    let i = 1;
    while (i < cumulative.length - 1 && cumulative[i]! < mile) i++;
    const segLen = cumulative[i]! - cumulative[i - 1]!;
    const t = segLen === 0 ? 0 : (mile - cumulative[i - 1]!) / segLen;
    const a = geometry[i - 1]!;
    const b = geometry[i]!;
    return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  };

  const marks: number[] = [];
  for (let m = 0; m < totalMiles; m += spacingMiles) marks.push(m);
  marks.push(totalMiles);
  const points = marks.map((mile, index) => {
    const p = at(mile);
    return { index, lat: p.lat, lng: p.lng, mileFromStart: mile, fraction: mile / totalMiles };
  });
  return { ok: true, corridor: { totalMiles, spacingMiles, points } };
}

/**
 * When he will be at a given mile: departure + the planned elapsed minutes (drive,
 * breaks and rests included) at the driven minutes that mile represents. Null when
 * the plan is infeasible or has no checkpoints - never a made-up time.
 */
export function etaAtMile(plan: RoutePlan, departAt: Date, mileFromStart: number, totalMiles: number): Date | null {
  if (!plan.feasible || plan.checkpoints.length === 0 || totalMiles <= 0) return null;
  const fraction = Math.min(1, Math.max(0, mileFromStart / totalMiles));
  const elapsed = elapsedAtDrivenMinutes(plan, fraction * plan.drivingMinutes);
  return new Date(departAt.getTime() + elapsed * 60_000);
}
