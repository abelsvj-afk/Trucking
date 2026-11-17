// Smart Path live awareness (owner 2026-11-17): bridges ahead on the
// route, with their posted clearance against his truck's height.
// Pure: the features come from the map data (Overpass); the clearance
// math is here. Only bridges WITH a recorded clearance are shown —
// a bridge with no recorded clearance is never presented as cleared,
// and the section says so. The truck's own nav/ELD is the final word.

import { distanceToRouteMiles, type LatLng } from "./smart-path";

export const NEAR_ROUTE_MILES = 5;
/** A posted limit this close above his truck is a caution, not a clear pass. */
export const TIGHT_CLEARANCE_IN = 6;

export interface BridgeFeature {
  id: string;
  point: LatLng;
  /** Posted clearance in inches, when the map records one; null when it does not. */
  maxHeightIn: number | null;
  name: string | null;
  road: string | null;
}

export type BridgeClearance = "below" | "tight" | "ok" | "unknown";

export interface BridgeItem {
  id: string;
  mile: number;
  /** When he reaches it, from the plan's corridor timing; null when the run cannot be timed. */
  etaAt: string | null;
  clearance: BridgeClearance;
  limitIn: number | null;
  truckHeightIn: number | null;
  text: string;
}

/**
 * Parses an OSM maxheight tag into inches. OSM's default unit is
 * meters ("4.2", "4.2 m"); US mappers often write feet and inches
 * ("13'6\"", "13 ft 6 in"). Anything else returns null — never a
 * guessed clearance.
 */
export function parseMaxHeight(tag: string): number | null {
  const t = tag.trim().toLowerCase();
  if (!t) return null;
  const feetMatch = t.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)?)?$/);
  if (feetMatch) {
    const feet = Number(feetMatch[1]);
    const inches = feetMatch[2] === undefined ? 0 : Number(feetMatch[2]);
    if (!Number.isFinite(feet) || !Number.isFinite(inches)) return null;
    return feet * 12 + inches;
  }
  const meterMatch = t.match(/^(\d+(?:[.,]\d+)?)\s*(m|meters?|metres?)?$/);
  if (meterMatch) {
    const meters = Number(meterMatch[1]!.replace(",", "."));
    if (!Number.isFinite(meters) || meters <= 0 || meters > 12) return null;
    return Math.round(meters * 39.3701 * 10) / 10;
  }
  return null;
}

/** "13'6\"" — the way a driver reads a clearance. */
export function formatHeightIn(inches: number): string {
  const feet = Math.floor(inches / 12);
  const rest = Math.round(inches % 12);
  return `${feet}'${rest}"`;
}

export function clearanceClass(limitIn: number | null, truckHeightIn: number | null): BridgeClearance {
  if (limitIn === null || truckHeightIn === null) return "unknown";
  if (limitIn < truckHeightIn) return "below";
  if (limitIn - truckHeightIn <= TIGHT_CLEARANCE_IN) return "tight";
  return "ok";
}

export interface CorridorTiming {
  mile: number;
  lat: number;
  lng: number;
  etaAt: string | null;
}

/**
 * Maps bridge features onto the route: nearest corridor point is
 * where he meets it. A bridge farther than NEAR_ROUTE_MILES from
 * the line, or at a point with no ETA, is not his bridge. Sorted
 * by mile.
 */
export function bridgeItems(
  features: BridgeFeature[],
  corridor: CorridorTiming[],
  truckHeightIn: number | null,
): BridgeItem[] {
  if (corridor.length === 0) return [];
  const geometry = corridor.map((c) => ({ lat: c.lat, lng: c.lng }));
  const items: BridgeItem[] = [];
  for (const f of features) {
    if (distanceToRouteMiles(f.point, geometry) > NEAR_ROUTE_MILES) continue;
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    corridor.forEach((c, i) => {
      const d = distanceToRouteMiles(f.point, [{ lat: c.lat, lng: c.lng }]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const at = corridor[best]!;
    if (!at.etaAt) continue;
    const clearance = clearanceClass(f.maxHeightIn, truckHeightIn);
    const road = f.road ?? f.name ?? "a bridge";
    const limitText = f.maxHeightIn !== null ? `posted ${formatHeightIn(f.maxHeightIn)}` : "no clearance posted in the map data";
    const truckText = truckHeightIn !== null ? `your truck is ${formatHeightIn(truckHeightIn)}` : "your truck height isn't in the app";
    const suffix =
      clearance === "below"
        ? " — UNDER your truck. Do not take this route past it; check the posted signs and your truck's own nav."
        : clearance === "tight"
          ? " — only just over your truck. Check the signs before you go under."
          : clearance === "unknown"
            ? " — clearance not recorded, so this is not a pass. Check the signs."
            : "";
    items.push({
      id: f.id,
      mile: Math.round(at.mile * 10) / 10,
      etaAt: at.etaAt,
      clearance,
      limitIn: f.maxHeightIn,
      truckHeightIn,
      text: `Bridge at mile ${Math.round(at.mile)} (${road}): ${limitText}, ${truckText}${suffix}.`,
    });
  }
  return items.sort((a, b) => a.mile - b.mile);
}
