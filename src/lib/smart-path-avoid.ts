// Smart Path live awareness (owner 2026-11-17): avoid areas for a
// truck-checked detour around a delay. Pure geometry: a circle
// becomes a polygon ring the routing engines understand (ORS
// avoid_polygons, Valhalla exclude_polygons). Equirectangular
// approximation — good for the small radii used here (<= 50 mi).

import type { LatLng } from "./smart-path";

export interface AvoidCircleInput {
  lat: number;
  lng: number;
  radiusMiles: number;
}

const EARTH_RADIUS_MILES = 3958.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** A circle as a closed [lng, lat] ring (16 points + close). */
export function circleToPolygonRing(circle: AvoidCircleInput, points = 16): [number, number][] {
  const radiusRad = circle.radiusMiles / EARTH_RADIUS_MILES;
  const latRad = toRad(circle.lat);
  const ring: [number, number][] = [];
  for (let i = 0; i < points; i++) {
    const bearing = (i / points) * 2 * Math.PI;
    const lat = Math.asin(
      Math.sin(latRad) * Math.cos(radiusRad) +
        Math.cos(latRad) * Math.sin(radiusRad) * Math.cos(bearing),
    );
    const lng =
      toRad(circle.lng) +
      Math.atan2(
        Math.sin(bearing) * Math.sin(radiusRad) * Math.cos(latRad),
        Math.cos(radiusRad) - Math.sin(latRad) * Math.sin(lat),
      );
    ring.push([Math.round(toDeg(lng) * 1e6) / 1e6, Math.round(toDeg(lat) * 1e6) / 1e6]);
  }
  ring.push(ring[0]!);
  return ring;
}

/** ORS shape: a GeoJSON MultiPolygon of the avoid circles. */
export function avoidCirclesToMultiPolygon(circles: AvoidCircleInput[]): {
  type: "MultiPolygon";
  coordinates: [number, number][][][];
} {
  return {
    type: "MultiPolygon",
    coordinates: circles.map((c) => [circleToPolygonRing(c)]),
  };
}

/** Valhalla shape: exclude_polygons — polygons of {lat, lon} rings. */
export function avoidCirclesToValhallaPolygons(
  circles: AvoidCircleInput[],
): { lat: number; lon: number }[][][] {
  return circles.map((c) => [
    circleToPolygonRing(c).map(([lng, lat]) => ({ lat, lon: lng })),
  ]);
}

/** The center point of a circle, for re-plotting on the map. */
export function avoidCircleCenter(circle: AvoidCircleInput): LatLng {
  return { lat: circle.lat, lng: circle.lng };
}
