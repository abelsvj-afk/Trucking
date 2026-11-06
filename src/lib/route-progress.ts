// Where the truck is along the planned route (Block C). Pure. The route is a polyline;
// progress is measured from the vertex nearest the truck. If the truck is not close to the
// line it is OFF ROUTE and no progress is claimed - the map shows the route without a
// "you are here" split, and says so. No route -> no result (nothing is invented).

import { haversineMiles, type LatLng } from "./smart-path";

/** Farther than this from the line = not on the route. */
export const ON_ROUTE_MILES = 1.5;

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

  let bestIdx = 0;
  let best = Number.POSITIVE_INFINITY;
  geometry.forEach((v, i) => {
    const d = haversineMiles(position, v);
    if (d < best) {
      best = d;
      bestIdx = i;
    }
  });
  const onRoute = best <= ON_ROUTE_MILES;
  if (!onRoute) {
    return { onRoute: false, offRouteMiles: best, totalMiles, milesDone: null, milesLeft: null, fraction: null, traveled: [], ahead: [] };
  }
  const milesDone = cumulative[bestIdx]!;
  return {
    onRoute: true,
    offRouteMiles: best,
    totalMiles,
    milesDone,
    milesLeft: Math.max(0, totalMiles - milesDone),
    fraction: milesDone / totalMiles,
    traveled: geometry.slice(0, bestIdx + 1),
    ahead: geometry.slice(bestIdx),
  };
}
