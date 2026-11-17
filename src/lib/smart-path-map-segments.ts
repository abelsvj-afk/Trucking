// Smart Path live awareness (owner 2026-11-17): the colored
// stretches of a route, as GeoJSON the map draws on top of the base
// route line. Pure: splits the route polyline at the segment mile
// marks so each stretch is its own LineString carrying its color.
// The map renders them with a data-driven line-color — no second
// renderer, no invented geometry.

import { haversineMiles, pointAlongRoute, type LatLng } from "./smart-path";

export interface MapSegment {
  fromMile: number;
  toMile: number;
  color: string;
}

export interface SegmentFeatureCollection {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    properties: { color: string };
    geometry: { type: "LineString"; coordinates: [number, number][] };
  }[];
}

function cumulativeMiles(geometry: LatLng[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < geometry.length; i++) out.push(out[i - 1]! + haversineMiles(geometry[i - 1]!, geometry[i]!));
  return out;
}

/** The sub-polyline of the route between two route miles, endpoints interpolated. */
export function sliceGeometry(geometry: LatLng[], fromMile: number, toMile: number): LatLng[] {
  if (geometry.length < 2) return [];
  const cum = cumulativeMiles(geometry);
  const total = cum[cum.length - 1]!;
  if (total <= 0 || toMile <= fromMile) return [];
  const start = pointAlongRoute(geometry, Math.max(0, fromMile) / total);
  const end = pointAlongRoute(geometry, Math.min(total, toMile) / total);
  if (!start || !end) return [];
  const pts: LatLng[] = [start];
  for (let i = 1; i < geometry.length; i++) {
    if (cum[i]! > fromMile && cum[i]! < toMile) pts.push(geometry[i]!);
  }
  pts.push(end);
  return pts;
}

export function segmentsToFeatureCollection(
  geometry: LatLng[],
  segments: MapSegment[],
): SegmentFeatureCollection {
  const features: SegmentFeatureCollection["features"] = [];
  for (const seg of segments) {
    const pts = sliceGeometry(geometry, seg.fromMile, seg.toMile);
    if (pts.length < 2) continue;
    features.push({
      type: "Feature",
      properties: { color: seg.color },
      geometry: { type: "LineString", coordinates: pts.map((p) => [p.lng, p.lat] as [number, number]) },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * The route from a fraction of its length onward — the remaining
 * run from where he is now. The first point is interpolated at the
 * fraction, then every vertex after it. Used by Drive's live poll.
 */
export function sliceGeometryFromFraction(geometry: LatLng[], fraction: number): LatLng[] {
  if (geometry.length < 2) return [...geometry];
  const clamped = Math.max(0, Math.min(1, fraction));
  const start = pointAlongRoute(geometry, clamped);
  if (!start) return [];
  const cum = cumulativeMiles(geometry);
  const total = cum[cum.length - 1]!;
  const startMile = clamped * total;
  const pts: LatLng[] = [start];
  for (let i = 1; i < geometry.length; i++) {
    if (cum[i]! > startMile) pts.push(geometry[i]!);
  }
  return pts;
}
