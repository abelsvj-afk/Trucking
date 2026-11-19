// "Where am I" for the drive map's pill (owner 2026-11-19, from the
// TruckPath reference: "I-10 W · MM245 / Greenville · FL"). Free-first:
//   - the road and the nearest mile marker from OpenStreetMap (Overpass):
//     the motor road under the truck (heading-aligned, like osm-speed.ts)
//     and the nearest `highway=milestone` node within MILESTONE_RADIUS_M;
//   - the town and state from OSM Nominatim reverse geocoding (its usage
//     policy: a real User-Agent, at most one request a second — the route
//     caches on a coarse grid, so a rolling truck asks a few times an hour).
// HONEST LIMITS: only what OSM records. Many US interstates have no
// milestone nodes — then no MM is shown, never an estimate. Untrusted
// external data: every field is schema-checked and length-capped.

import { z } from "zod";
import type { LatLng } from "@/lib/smart-path";

export const MILESTONE_RADIUS_M = 1_600;
const ROAD_RADIUS_M = 40;
const MAX_HEADING_DIFF_DEG = 35;
const NON_MOTOR = new Set(["footway", "cycleway", "path", "steps", "pedestrian", "bridleway", "corridor", "elevator", "proposed", "construction", "track", "service"]);

const cap = (s: string | undefined, n = 60) => (s ? s.slice(0, n) : undefined);

const overpassSchema = z.object({
  elements: z.array(
    z.object({
      type: z.string(),
      id: z.number(),
      lat: z.number().optional(),
      lon: z.number().optional(),
      tags: z.record(z.string(), z.string()).optional(),
      geometry: z.array(z.object({ lat: z.number(), lon: z.number() })).optional(),
    }),
  ),
});

const nominatimSchema = z.object({
  address: z
    .object({
      city: z.string().optional(),
      town: z.string().optional(),
      village: z.string().optional(),
      hamlet: z.string().optional(),
      county: z.string().optional(),
      "ISO3166-2-lvl4": z.string().optional(),
      state: z.string().optional(),
    })
    .optional(),
});

export interface RoadHere {
  /** "I-10", "US-231" — the route number when OSM has one. */
  ref: string | null;
  name: string | null;
  /** The nearest mile marker on this road, when OSM records one nearby. */
  mileMarker: string | null;
}

export interface PlaceHere {
  town: string | null;
  /** Two-letter state code ("FL") when known. */
  state: string | null;
}

function bearing(a: LatLng, b: LatLng): number {
  const y = Math.sin(((b.lng - a.lng) * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180);
  const x =
    Math.cos((a.lat * Math.PI) / 180) * Math.sin((b.lat * Math.PI) / 180) -
    Math.sin((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.cos(((b.lng - a.lng) * Math.PI) / 180);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function metres(a: LatLng, b: LatLng): number {
  const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((b.lng - a.lng) * kx, (b.lat - a.lat) * 110_540);
}

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

/** "I 10;US 90" -> "I-10" (the first, dash-joined — how drivers say it). */
export function formatRef(ref: string | undefined): string | null {
  if (!ref) return null;
  const first = ref.split(";")[0]!.trim();
  if (!first) return null;
  return first.replace(/^([A-Z]{1,3})\s+(\d)/, "$1-$2").slice(0, 20);
}

/** Pure: the road under the truck and its nearest mile marker, or null when no motor road is under it. */
export function pickRoadHere(json: unknown, position: LatLng, headingDeg: number | null): RoadHere | null {
  const parsed = overpassSchema.safeParse(json);
  if (!parsed.success) return null;
  let best: { d: number; ref: string | null; name: string | null } | null = null;
  const milestones: { d: number; value: string; ref: string | null }[] = [];
  for (const el of parsed.data.elements) {
    const tags = el.tags ?? {};
    if (el.type === "node" && tags.highway === "milestone" && el.lat !== undefined && el.lon !== undefined) {
      const value = tags.distance ?? tags.name;
      if (value && /^\d{1,4}(\.\d)?$/.test(value.trim())) {
        milestones.push({ d: metres(position, { lat: el.lat, lng: el.lon }), value: value.trim(), ref: formatRef(tags["highway:ref"] ?? tags.ref) });
      }
      continue;
    }
    if (el.type !== "way" || !tags.highway || NON_MOTOR.has(tags.highway) || !el.geometry || el.geometry.length < 2) continue;
    for (let i = 1; i < el.geometry.length; i++) {
      const a = { lat: el.geometry[i - 1]!.lat, lng: el.geometry[i - 1]!.lon };
      const b = { lat: el.geometry[i]!.lat, lng: el.geometry[i]!.lon };
      const d = distToSegmentM(position, a, b);
      if (d > ROAD_RADIUS_M) continue;
      if (headingDeg !== null) {
        const diff = Math.abs(((headingDeg - bearing(a, b)) % 180 + 180) % 180);
        if (Math.min(diff, 180 - diff) > MAX_HEADING_DIFF_DEG) continue;
      }
      if (!best || d < best.d) best = { d, ref: formatRef(tags.ref), name: cap(tags.name) ?? null };
    }
  }
  if (!best) return null;
  // A milestone counts only on THIS road: same ref when either side names one.
  const road = best;
  const marker = milestones
    .filter((m) => m.d <= MILESTONE_RADIUS_M && (m.ref === null || road.ref === null || m.ref === road.ref))
    .sort((x, y) => x.d - y.d)[0];
  return { ref: road.ref, name: road.name, mileMarker: marker ? marker.value : null };
}

/** Pure: town + two-letter state from a Nominatim reverse answer. */
export function pickPlaceHere(json: unknown): PlaceHere {
  const parsed = nominatimSchema.safeParse(json);
  const a = parsed.success ? parsed.data.address : undefined;
  const town = cap(a?.city ?? a?.town ?? a?.village ?? a?.hamlet, 40) ?? null;
  const iso = a?.["ISO3166-2-lvl4"];
  const state = iso && /^US-[A-Z]{2}$/.test(iso) ? iso.slice(3) : null;
  return { town, state };
}

export class WhereUnavailableError extends Error {}

const UA = "TruckingRouteCheck/1.0 (owner-operator drive map)";

export async function fetchRoadHere(position: LatLng, headingDeg: number | null, fetchFn: typeof fetch = fetch): Promise<RoadHere | null> {
  const { lat, lng } = position;
  const query =
    `[out:json][timeout:8];(way(around:${ROAD_RADIUS_M},${lat},${lng})["highway"];` +
    `node(around:${MILESTONE_RADIUS_M},${lat},${lng})["highway"="milestone"];);out tags geom;`;
  let res: Response;
  try {
    res = await fetchFn("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: `data=${encodeURIComponent(query)}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      signal: AbortSignal.timeout(9_000),
    });
  } catch {
    throw new WhereUnavailableError("Overpass could not be reached.");
  }
  if (!res.ok) throw new WhereUnavailableError(`Overpass answered HTTP ${res.status}.`);
  return pickRoadHere(await res.json(), position, headingDeg);
}

export async function fetchPlaceHere(position: LatLng, fetchFn: typeof fetch = fetch): Promise<PlaceHere> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&addressdetails=1&lat=${position.lat.toFixed(4)}&lon=${position.lng.toFixed(4)}`;
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
  } catch {
    throw new WhereUnavailableError("Nominatim could not be reached.");
  }
  if (!res.ok) throw new WhereUnavailableError(`Nominatim answered HTTP ${res.status}.`);
  return pickPlaceHere(await res.json());
}
