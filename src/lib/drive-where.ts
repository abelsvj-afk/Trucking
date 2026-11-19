// The drive map's "where am I" pill text and the speed box's colour
// (owner 2026-11-19, the TruckPath reference). Pure.

/** Cardinal direction for a numbered US route: even = E/W, odd = N/S (the Interstate/US numbering rule). */
export function routeDirection(ref: string | null, headingDeg: number | null): "N" | "S" | "E" | "W" | null {
  if (!ref || headingDeg === null) return null;
  const n = ref.match(/^(I|US|SR|[A-Z]{2})-(\d+)/);
  if (!n) return null;
  const even = Number(n[2]) % 2 === 0;
  const h = ((headingDeg % 360) + 360) % 360;
  if (even) return h < 180 ? "E" : "W";
  return h < 90 || h >= 270 ? "N" : "S";
}

export interface WhereHere {
  roadRef: string | null;
  roadName: string | null;
  mileMarker: string | null;
  town: string | null;
  state: string | null;
}

/** Top line "I-10 W · MM245", bottom line "Greenville · FL"; null parts are left out, never guessed. */
export function wherePillLines(where: WhereHere | null, headingDeg: number | null): { top: string | null; bottom: string | null } {
  if (!where) return { top: null, bottom: null };
  const dir = routeDirection(where.roadRef, headingDeg);
  const road = where.roadRef ? `${where.roadRef}${dir ? ` ${dir}` : ""}` : where.roadName;
  const top = [road, where.mileMarker ? `MM${where.mileMarker}` : null].filter(Boolean).join(" · ") || null;
  const bottom = [where.town, where.state].filter(Boolean).join(" · ") || null;
  return { top, bottom };
}

/** The speed number's colour: normal at or under the limit, orange over it, red 10+ over. */
export function speedTone(speedMph: number | null, limitMph: number | null): "normal" | "over" | "well_over" {
  if (speedMph === null || limitMph === null) return "normal";
  if (speedMph >= limitMph + 10) return "well_over";
  if (speedMph > limitMph) return "over";
  return "normal";
}
