// Smart Path intelligence, Phase 1 (docs/design/smart-path-intelligence.md §1):
// which states a route crosses, in order, with the miles it enters and leaves
// each. Pure; uses a bundled low-resolution boundary set (US Census-derived state
// outlines, src/data/us-state-boundaries.json) - no network, no key, never stale.
// The outlines are coarse (a few miles at borders and coasts), so every border
// mile here is APPROXIMATE and the UI says so. A point that falls in no outline
// snaps to the nearest state only when it is within SNAP_MILES; otherwise it is
// reported as unknown rather than guessed.

import boundaries from "@/data/us-state-boundaries.json";
import { haversineMiles } from "./smart-path";
import type { CorridorPoint } from "./smart-path-corridor";

type Ring = [number, number][]; // [lng, lat]
const STATES = boundaries as unknown as Record<string, Ring[]>;

export const SNAP_MILES = 15;

function inRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Two-letter state code for a point, or null when it is in no outline and not near one. */
export function stateAt(lat: number, lng: number): string | null {
  for (const [code, polys] of Object.entries(STATES)) {
    if (polys.some((ring) => inRing(lng, lat, ring))) return code;
  }
  let best: string | null = null;
  let bestMiles = SNAP_MILES;
  for (const [code, polys] of Object.entries(STATES)) {
    for (const ring of polys) {
      for (const [x, y] of ring) {
        const d = haversineMiles({ lat, lng }, { lat: y, lng: x });
        if (d < bestMiles) {
          bestMiles = d;
          best = code;
        }
      }
    }
  }
  return best;
}

export interface StateStretch {
  state: string | null;
  enterMile: number;
  exitMile: number;
}

/** Consecutive corridor points in the same state become one stretch; borders fall midway between points. */
export function statesAlongRoute(points: CorridorPoint[]): StateStretch[] {
  if (points.length === 0) return [];
  const codes = points.map((p) => stateAt(p.lat, p.lng));
  const stretches: StateStretch[] = [];
  let startIdx = 0;
  for (let i = 1; i <= points.length; i++) {
    if (i < points.length && codes[i] === codes[startIdx]) continue;
    const enterMile = startIdx === 0 ? points[0]!.mileFromStart : (points[startIdx - 1]!.mileFromStart + points[startIdx]!.mileFromStart) / 2;
    const exitMile = i === points.length ? points[points.length - 1]!.mileFromStart : (points[i - 1]!.mileFromStart + points[i]!.mileFromStart) / 2;
    stretches.push({ state: codes[startIdx]!, enterMile, exitMile });
    startIdx = i;
  }
  return stretches;
}

/** EIA PADD region codes (the `duoarea` facet): R10 East Coast, R20 Midwest, R30 Gulf Coast, R40 Rocky Mountain, R50 West Coast. */
export const PADD_BY_STATE: Record<string, { code: string; name: string }> = {};
const PADDS: [string, string, string[]][] = [
  ["R10", "East Coast", ["CT", "DE", "DC", "FL", "GA", "ME", "MD", "MA", "NH", "NJ", "NY", "NC", "PA", "RI", "SC", "VT", "VA", "WV"]],
  ["R20", "Midwest", ["IL", "IN", "IA", "KS", "KY", "MI", "MN", "MO", "NE", "ND", "OH", "OK", "SD", "TN", "WI"]],
  ["R30", "Gulf Coast", ["AL", "AR", "LA", "MS", "NM", "TX"]],
  ["R40", "Rocky Mountain", ["CO", "ID", "MT", "UT", "WY"]],
  ["R50", "West Coast", ["AK", "AZ", "CA", "HI", "NV", "OR", "WA"]],
];
for (const [code, name, states] of PADDS) for (const s of states) PADD_BY_STATE[s] = { code, name };
