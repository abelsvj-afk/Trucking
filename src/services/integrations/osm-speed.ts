// Posted speed limit for the road the truck is on, from OpenStreetMap `maxspeed` tags via
// the Overpass API (Block C, owner 2026-11-05). The map stack is keyless OSM, so this is the
// same source family as the tiles, routing and places.
//
// HONESTY RULES: a limit is returned ONLY when a nearby way carries a plain numeric
// `maxspeed` (e.g. "55 mph"). No tag, "none", "signals", "walk", a country code or any
// other non-numeric value, no way close enough to the truck, or any Overpass failure ->
// null, and the app shows NO badge. Nothing is ever estimated, defaulted from the road
// class, or carried from a previous road. A plain number without a unit is km/h in OSM and
// is converted. Direction-specific tags (maxspeed:forward/backward) are ignored on purpose:
// without a verified direction of travel on a one-way, no limit is claimed.

import { z } from "zod";
import type { LatLng } from "@/lib/smart-path";
import { bearingDeg } from "@/lib/heading";

export const SEARCH_RADIUS_M = 30;
/** The truck must be this close (metres) to the way's line to count as being on it. */
export const MAX_ON_ROAD_M = 25;
/** With a known heading, a way whose direction differs by more than this (mod 180) is a cross street. */
export const MAX_HEADING_DIFF_DEG = 35;

const responseSchema = z.object({
  elements: z.array(
    z.object({
      type: z.string(),
      id: z.number(),
      tags: z.record(z.string(), z.string()).optional(),
      geometry: z.array(z.object({ lat: z.number(), lon: z.number() })).optional(),
    }),
  ),
});

export interface SpeedLimit {
  mph: number;
  wayId: number;
  roadName: string | null;
}

/** "55 mph" -> 55; "50" -> 31 (km/h); anything else -> null. Never guesses. */
export function parseMaxspeed(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^\s*(\d{1,3})\s*(mph|km\/h|kmh)?\s*$/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  const unit = (m[2] ?? "").toLowerCase();
  const mph = unit === "mph" ? n : Math.round(n * 0.621371);
  // A posted limit outside any real road's range is bad data, not a limit.
  return mph >= 5 && mph <= 85 ? mph : null;
}

/** Metres from p to segment ab (equirectangular - plenty at tens of metres). */
function distToSegmentM(p: LatLng, a: LatLng, b: LatLng): number {
  const kx = 111_320 * Math.cos((p.lat * Math.PI) / 180);
  const ky = 110_540;
  const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky;
  const bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Highway types a truck is not driving on - never the road under it. */
const NON_MOTOR = new Set(["footway", "cycleway", "path", "steps", "pedestrian", "bridleway", "corridor", "elevator", "proposed", "construction", "track"]);
/** A second, equally-near way within this many extra metres makes the answer ambiguous. */
const AMBIGUITY_MARGIN_M = 8;

/**
 * Pure: pick the limit for the road the truck is on, or null.
 * The road is chosen FIRST (nearest motor-road way, aligned with the heading when known) and only
 * THEN is its maxspeed read - so an untagged main road is never given the limit of a tagged
 * frontage road next to it. Two near-equal candidates with different limits (an overpass, a
 * dual carriageway read ambiguously) give null rather than a coin flip.
 */
export function pickSpeedLimit(json: unknown, position: LatLng, headingDeg: number | null): SpeedLimit | null {
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) return null;
  const candidates: { distance: number; mph: number | null; wayId: number; roadName: string | null }[] = [];
  for (const el of parsed.data.elements) {
    const highway = el.tags?.highway;
    if (el.type !== "way" || !highway || NON_MOTOR.has(highway) || !el.geometry || el.geometry.length < 2) continue;
    let nearest = Number.POSITIVE_INFINITY;
    for (let i = 1; i < el.geometry.length; i++) {
      const a = { lat: el.geometry[i - 1]!.lat, lng: el.geometry[i - 1]!.lon };
      const b = { lat: el.geometry[i]!.lat, lng: el.geometry[i]!.lon };
      const d = distToSegmentM(position, a, b);
      if (d > MAX_ON_ROAD_M) continue;
      if (headingDeg !== null) {
        const diff = Math.abs(((headingDeg - bearingDeg(a, b)) % 180 + 180) % 180);
        if (Math.min(diff, 180 - diff) > MAX_HEADING_DIFF_DEG) continue; // a cross street, not our road
      }
      if (d < nearest) nearest = d;
    }
    if (!Number.isFinite(nearest)) continue;
    candidates.push({ distance: nearest, mph: parseMaxspeed(el.tags?.maxspeed), wayId: el.id, roadName: el.tags?.name ?? el.tags?.ref ?? null });
  }
  if (candidates.length === 0) return null;
  candidates.sort((x, y) => x.distance - y.distance);
  const best = candidates[0]!;
  if (best.mph === null) return null; // the road we are on has no usable posted limit
  const rival = candidates.find((c, i) => i > 0 && c.distance - best.distance <= AMBIGUITY_MARGIN_M && c.mph !== best.mph);
  if (rival) return null;
  return { mph: best.mph, wayId: best.wayId, roadName: best.roadName };
}

export class SpeedLimitUnavailableError extends Error {}

export async function fetchSpeedLimit(position: LatLng, headingDeg: number | null, fetchFn: typeof fetch = fetch): Promise<SpeedLimit | null> {
  const query =
    `[out:json][timeout:8];way(around:${SEARCH_RADIUS_M},${position.lat},${position.lng})["highway"];out tags geom;`;
  let res: Response;
  try {
    res = await fetchFn("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: `data=${encodeURIComponent(query)}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "TruckingRouteCheck/1.0 (owner-operator speed limit)" },
      signal: AbortSignal.timeout(9_000),
    });
  } catch {
    throw new SpeedLimitUnavailableError("Overpass could not be reached.");
  }
  if (!res.ok) throw new SpeedLimitUnavailableError(`Overpass answered HTTP ${res.status}.`);
  return pickSpeedLimit(await res.json(), position, headingDeg);
}

