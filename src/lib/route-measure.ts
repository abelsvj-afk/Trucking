// One way of measuring miles on the drive map (owner 2026-11-18: the
// app said 11 mi to I-20 while his other map said 19).
//
// The cause was two scales mixed together. The route LINE is a
// simplified polyline whose own length (great-circle between its
// points) cuts corners and is shorter than the road; the routing
// service's `distanceMiles` is the real road length. Some numbers on
// the screen were line miles, some were road miles, and some were
// one divided by the other.
//
// From here on every distance on the map is ROAD miles, measured the
// same way: project the point onto the nearest SEGMENT of the line
// (never snap to a vertex), take the line length up to that point,
// and scale it to road miles leg by leg (deadhead and loaded legs
// are scaled separately, since the router simplifies them
// differently). The truck, every turn, every stop, every truck stop
// and the countdown all go through `measurePoint`, so the number on
// screen, the countdown and the list always agree with each other —
// and, being road miles, with other road maps.
//
// Pure: no React, no map.

import { haversineMiles, type LatLng } from "./smart-path";

/** Farther than this from the line = off the route (same band as route-progress). */
export const MEASURE_ON_ROUTE_MILES = 1.5;

const EARTH_RADIUS_MILES = 3958.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export interface RouteLeg {
  geometry: LatLng[];
  /** The router's road miles for this leg. */
  roadMiles: number;
}

export interface RouteMeasure {
  geometry: LatLng[];
  /** Road miles at each vertex of `geometry`. */
  roadMilesAtVertex: number[];
  totalRoadMiles: number;
}

function samePoint(a: LatLng, b: LatLng): boolean {
  return a.lat === b.lat && a.lng === b.lng;
}

/** Join legs (de-duplicating the shared joint point) and calibrate each leg's line length to its road miles. */
export function buildRouteMeasure(legs: RouteLeg[]): RouteMeasure {
  const geometry: LatLng[] = [];
  const roadMilesAtVertex: number[] = [];
  let offset = 0;
  for (const leg of legs) {
    if (leg.geometry.length === 0) continue;
    const pts = geometry.length > 0 && samePoint(geometry[geometry.length - 1]!, leg.geometry[0]!) ? leg.geometry.slice(1) : leg.geometry;
    const lineCum: number[] = [];
    let line = 0;
    let prev = geometry.length > 0 && pts !== leg.geometry ? geometry[geometry.length - 1]! : null;
    for (const p of pts) {
      if (prev) line += haversineMiles(prev, p);
      lineCum.push(line);
      prev = p;
    }
    const road = leg.roadMiles > 0 ? leg.roadMiles : line;
    const scale = line > 0 ? road / line : 0;
    pts.forEach((p, i) => {
      geometry.push(p);
      roadMilesAtVertex.push(offset + lineCum[i]! * scale);
    });
    offset += road;
  }
  return { geometry, roadMilesAtVertex, totalRoadMiles: offset };
}

export interface PointMeasure {
  /** Road miles from the start of the route to where the point meets the line. */
  roadMiles: number;
  /** Miles from the point to the line. */
  offRouteMiles: number;
  onRoute: boolean;
  /** Index of the segment the point projects onto (start vertex). */
  segment: number;
}

/** Where a point meets the route, in road miles (segment projection). Null with no line. */
export function measurePoint(m: RouteMeasure, point: LatLng): PointMeasure | null {
  const g = m.geometry;
  if (g.length < 2) return null;
  const cosLat = Math.cos(toRad(point.lat));
  const toXY = (p: LatLng) => ({
    x: toRad(p.lng - point.lng) * cosLat * EARTH_RADIUS_MILES,
    y: toRad(p.lat - point.lat) * EARTH_RADIUS_MILES,
  });
  let best = Number.POSITIVE_INFINITY;
  let bestSeg = 0;
  let bestT = 0;
  let prev = toXY(g[0]!);
  for (let i = 1; i < g.length; i++) {
    const cur = toXY(g[i]!);
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(prev.x * dx + prev.y * dy) / len2));
    const d = Math.hypot(prev.x + t * dx, prev.y + t * dy);
    if (d < best) {
      best = d;
      bestSeg = i - 1;
      bestT = t;
    }
    prev = cur;
  }
  const a = m.roadMilesAtVertex[bestSeg]!;
  const b = m.roadMilesAtVertex[bestSeg + 1]!;
  return { roadMiles: a + (b - a) * bestT, offRouteMiles: best, onRoute: best <= MEASURE_ON_ROUTE_MILES, segment: bestSeg };
}

/** The point on the line at a road-miles mark (clamped to the route). */
export function pointAtRoadMiles(m: RouteMeasure, miles: number): LatLng | null {
  const g = m.geometry;
  if (g.length === 0) return null;
  if (g.length === 1 || miles <= 0) return g[0]!;
  const v = m.roadMilesAtVertex;
  if (miles >= v[v.length - 1]!) return g[g.length - 1]!;
  let lo = 0;
  let hi = v.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (v[mid]! <= miles) lo = mid;
    else hi = mid;
  }
  const span = v[hi]! - v[lo]!;
  const t = span > 0 ? (miles - v[lo]!) / span : 0;
  return { lat: g[lo]!.lat + (g[hi]!.lat - g[lo]!.lat) * t, lng: g[lo]!.lng + (g[hi]!.lng - g[lo]!.lng) * t };
}

/** Direction of travel along the line at a road-miles mark, degrees clockwise from north. */
export function headingAtRoadMiles(m: RouteMeasure, miles: number): number | null {
  const g = m.geometry;
  if (g.length < 2) return null;
  const v = m.roadMilesAtVertex;
  let i = 0;
  while (i < v.length - 2 && v[i + 1]! <= miles) i++;
  // Skip zero-length segments so a duplicated vertex never gives a null bearing.
  let j = i + 1;
  while (j < g.length - 1 && samePoint(g[i]!, g[j]!)) j++;
  return bearingDeg(g[i]!, g[j]!);
}

/** Initial great-circle bearing a → b, degrees clockwise from north; null when a = b. */
export function bearingDeg(a: LatLng, b: LatLng): number | null {
  if (samePoint(a, b)) return null;
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** The stretch of line between two road-miles marks (for colored / striped hazard stretches). */
export function stretchAlong(m: RouteMeasure, fromMiles: number, toMiles: number): LatLng[] {
  const lo = Math.max(0, Math.min(fromMiles, toMiles));
  const hi = Math.min(m.totalRoadMiles, Math.max(fromMiles, toMiles));
  if (hi <= lo || m.geometry.length < 2) return [];
  const out: LatLng[] = [pointAtRoadMiles(m, lo)!];
  m.roadMilesAtVertex.forEach((v, i) => {
    if (v > lo && v < hi) out.push(m.geometry[i]!);
  });
  out.push(pointAtRoadMiles(m, hi)!);
  return out;
}
