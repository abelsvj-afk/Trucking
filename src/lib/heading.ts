// Heading for the map marker (Block C). The phone's reported heading (coords.heading)
// is only meaningful while moving; when it is missing we derive one from where the
// truck actually went, and when the truck is stopped we HOLD the last heading instead
// of letting a wobbling standstill spin the icon. Pure.

import type { LatLng } from "./smart-path";

const R_M = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_M * Math.asin(Math.sqrt(h));
}

/** Initial bearing from a to b, degrees clockwise from north, 0-360. */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (((Math.atan2(y, x) * 180) / Math.PI) % 360 + 360) % 360;
}

/** Below this movement a bearing between two fixes is jitter, not a heading. */
export const MIN_BEARING_MOVE_M = 15;
/** The reported heading is trusted only above this speed. */
export const MIN_HEADING_MPH = 3;

export function nextHeading(input: {
  previous: LatLng | null;
  current: LatLng;
  reportedDeg: number | null;
  speedMph: number | null;
  held: number | null;
}): number | null {
  const { previous, current, reportedDeg, speedMph, held } = input;
  if (reportedDeg !== null && Number.isFinite(reportedDeg) && speedMph !== null && speedMph >= MIN_HEADING_MPH) {
    return ((reportedDeg % 360) + 360) % 360;
  }
  if (previous && distanceM(previous, current) >= MIN_BEARING_MOVE_M && (speedMph === null || speedMph >= MIN_HEADING_MPH)) {
    return bearingDeg(previous, current);
  }
  return held;
}
