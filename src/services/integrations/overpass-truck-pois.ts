// Truck-relevant POIs ahead (audit-fix B7, 2026-11-18): truck stops
// and fuel, rest areas, and truck parking, from OpenStreetMap via
// the Overpass API — keyless, the same provider family as the
// bridges lookup (overpass-bridges.ts), free-first, no new provider.
//
// HONEST LIMITS: only what OSM records is returned. A fuel station
// or rest area missing from the map is never invented, and a stop
// listed here is a map record, not a guarantee of parking, diesel,
// or opening hours — the signs and the stop itself are the final
// word. One Overpass call per ~100 route miles, 10-minute server
// cache (POI data barely changes over a run).

import { z } from "zod";
import type { LatLng } from "@/lib/smart-path";
import { corridorBboxes } from "./tomtom-traffic";

export class OverpassTruckPoisError extends Error {}

export type TruckPoiKind = "truck_stop" | "fuel" | "rest" | "parking";

export interface TruckPoiFeature {
  id: string;
  point: LatLng;
  kind: TruckPoiKind;
  /** OSM name or brand, when the map records one; null when it does not. */
  name: string | null;
}

const overpassResponseSchema = z.object({
  elements: z.array(
    z.object({
      type: z.string(),
      id: z.number(),
      lat: z.number().optional(),
      lon: z.number().optional(),
      center: z.object({ lat: z.number(), lon: z.number() }).optional(),
      tags: z.record(z.string(), z.string()).optional(),
    }),
  ),
});

const FETCH_TIMEOUT_MS = 25_000;
export const MAX_BBOX_CALLS = 6;
const CACHE_TTL_MS = 600_000;

interface CacheEntry {
  at: number;
  features: TruckPoiFeature[];
}

const cache = new Map<string, CacheEntry>();

export function clearOverpassTruckPoisCache(): void {
  cache.clear();
}

export interface FetchTruckPoiFeaturesInput {
  fetchFn?: typeof fetch;
  /** Corridor points in route order. */
  points: LatLng[];
  now?: Date;
}

export async function fetchTruckPoiFeatures(
  input: FetchTruckPoiFeaturesInput,
): Promise<TruckPoiFeature[]> {
  const { fetchFn = fetch, points } = input;
  if (points.length === 0) return [];
  const bboxes = corridorBboxes(points, 100, 2).slice(0, MAX_BBOX_CALLS);
  const cacheKey = bboxes.map((b) => `${b.minLat.toFixed(3)},${b.minLng.toFixed(3)},${b.maxLat.toFixed(3)},${b.maxLng.toFixed(3)}`).join("|");
  const nowMs = (input.now ?? new Date()).getTime();
  const cached = cache.get(cacheKey);
  if (cached && nowMs - cached.at < CACHE_TTL_MS) return cached.features;

  const seen = new Set<string>();
  const features: TruckPoiFeature[] = [];
  for (const b of bboxes) {
    // Overpass bbox order: south,west,north,east.
    const bbox = `${b.minLat},${b.minLng},${b.maxLat},${b.maxLng}`;
    const query =
      `[out:json][timeout:25];` +
      `(` +
      `node["amenity"="fuel"](${bbox});` +
      `way["amenity"="fuel"](${bbox});` +
      `node["highway"="rest_area"](${bbox});` +
      `node["highway"="services"](${bbox});` +
      `way["highway"="services"](${bbox});` +
      `way["highway"="rest_area"](${bbox});` +
      `node["amenity"="parking"]["hgv"](${bbox});` +
      `way["amenity"="parking"]["hgv"](${bbox});` +
      `);` +
      `out tags center;`;
    let response: Response;
    try {
      response = await fetchFn("https://overpass-api.de/api/interpreter", {
        method: "POST",
        body: `data=${encodeURIComponent(query)}`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "TruckingOS-SmartPath/1.0 (route planning; single-owner app)",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new OverpassTruckPoisError(
        `Overpass unreachable: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
    if (!response.ok) {
      throw new OverpassTruckPoisError(`Overpass answered HTTP ${response.status}.`);
    }
    const parsed = overpassResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new OverpassTruckPoisError("Overpass returned an unexpected response shape.");
    }
    for (const element of parsed.data.elements) {
      const lat = element.lat ?? element.center?.lat;
      const lng = element.lon ?? element.center?.lon;
      if (lat === undefined || lng === undefined) continue;
      const id = `${element.type}/${element.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const tags = element.tags ?? {};
      // A place can carry several tags (a fuel station that is also
      // truck parking). Truck stops first (a travel plaza, or fuel
      // OSM marks as serving big trucks), then rest areas, fuel,
      // parking. Only what OSM records: an untagged truck stop shows
      // as plain fuel, never guessed from its name.
      const truckFuel =
        tags.amenity === "fuel" && (tags.hgv === "yes" || tags.hgv === "designated" || tags["fuel:HGV_diesel"] === "yes");
      const kind: TruckPoiKind =
        tags.highway === "services" || truckFuel
          ? "truck_stop"
          : tags.highway === "rest_area"
            ? "rest"
            : tags.amenity === "fuel"
              ? "fuel"
              : "parking";
      features.push({
        id,
        point: { lat, lng },
        kind,
        name: tags.name ?? tags.brand ?? tags.operator ?? null,
      });
    }
  }
  cache.set(cacheKey, { at: nowMs, features });
  return features;
}
