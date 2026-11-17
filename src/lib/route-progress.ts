// Where the truck is along the planned route (Block C). Pure. The route is a polyline;
// progress is measured from the truck's PROJECTION onto the line — the closest
// point on any segment — not from the nearest vertex. Routing geometry is
// sparse on long straight stretches (a straight interstate run can span miles
// between shape points), so a vertex snap can put the truck miles ahead of
// where it really is and every "miles to" number downstream inherits the
// error. If the truck is not close to the line it is OFF ROUTE and no
// progress is claimed - the map shows the route without a "you are here"
// split, and says so. No route -> no result (nothing is invented).

import { haversineMiles, type LatLng } from "./smart-path";

/** Farther than this from the line = not on the route. */
export const ON_ROUTE_MILES = 1.5;

const EARTH_RADIUS_MILES = 3958.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export interface RouteProgress {
  onRoute: boolean;
  /** Miles from the truck to the nearest point of the line. */
  offRouteMiles: number;
  totalMiles: number;
  /** Miles driven along the route; null when off route. */
  milesDone: number | null;
  milesLeft: number | null;
  fraction: number | null;
  /** Geometry already behind the truck (first part), and ahead of it. Both empty when off route. */
  traveled: LatLng[];
  ahead: LatLng[];
}

export function routeProgress(position: LatLng, geometry: LatLng[]): RouteProgress | null {
  if (geometry.length < 2) return null;
  const cumulative: number[] = [0];
  for (let i = 1; i < geometry.length; i++) cumulative.push(cumulative[i - 1]! + haversineMiles(geometry[i - 1]!, geometry[i]!));
  const totalMiles = cumulative[cumulative.length - 1]!;
  if (totalMiles <= 0) return null;

  // Local planar coordinates in miles, with the truck at the origin
  // (same equirectangular projection as distanceToRouteMiles).
  const cosLat = Math.cos(toRad(position.lat));
  const toXY = (p: LatLng) => ({
    x: toRad(p.lng - position.lng) * cosLat * EARTH_RADIUS_MILES,
    y: toRad(p.lat - position.lat) * EARTH_RADIUS_MILES,
  });
  const fromXY = (x: number, y: number): LatLng => ({
    lat: position.lat + (y / EARTH_RADIUS_MILES) * (180 / Math.PI),
    lng: position.lng + (x / (cosLat * EARTH_RADIUS_MILES)) * (180 / Math.PI),
  });

  let bestDist = Number.POSITIVE_INFINITY;
  let bestSeg = 0;
  let bestT = 0;
  let bestPoint: LatLng = geometry[0]!;
  let prev = toXY(geometry[0]!);
  for (let i = 1; i < geometry.length; i++) {
    const cur = toXY(geometry[i]!);
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    const len2 = dx * dx + dy * dy;
    // Projection of the truck (the origin) onto the segment, clamped to it.
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(prev.x * dx + prev.y * dy) / len2));
    const px = prev.x + t * dx;
    const py = prev.y + t * dy;
    const d = Math.hypot(px, py);
    if (d < bestDist) {
      bestDist = d;
      bestSeg = i - 1;
      bestT = t;
      bestPoint = fromXY(px, py);
    }
    prev = cur;
  }
  const onRoute = bestDist <= ON_ROUTE_MILES;
  if (!onRoute) {
    return { onRoute: false, offRouteMiles: bestDist, totalMiles, milesDone: null, milesLeft: null, fraction: null, traveled: [], ahead: [] };
  }
  const segLen = haversineMiles(geometry[bestSeg]!, geometry[bestSeg + 1]!);
  const milesDone = cumulative[bestSeg]! + bestT * segLen;
  // The split is at the projected point, not at a vertex, so the line
  // ahead starts exactly where the truck is. On a vertex exactly, the
  // split is that vertex (no duplicate point).
  const eps = 1e-9;
  const traveled =
    bestT <= eps
      ? geometry.slice(0, bestSeg + 1)
      : bestT >= 1 - eps
        ? geometry.slice(0, bestSeg + 2)
        : [...geometry.slice(0, bestSeg + 1), bestPoint];
  const ahead =
    bestT <= eps
      ? geometry.slice(bestSeg)
      : bestT >= 1 - eps
        ? geometry.slice(bestSeg + 1)
        : [bestPoint, ...geometry.slice(bestSeg + 1)];
  return {
    onRoute: true,
    offRouteMiles: bestDist,
    totalMiles,
    milesDone,
    milesLeft: Math.max(0, totalMiles - milesDone),
    fraction: milesDone / totalMiles,
    traveled,
    ahead,
  };
}
