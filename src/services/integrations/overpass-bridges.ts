// Smart Path live awareness (owner 2026-11-17): bridges ahead with
// a posted clearance, from OpenStreetMap via the Overpass API —
// keyless, same provider family as the app's places lookup.
//
// HONEST LIMITS: only bridges WITH a recorded maxheight are
// returned. A bridge with no recorded clearance is never presented
// as cleared — it simply is not listed, and the section says so.
// OSM restriction data is incomplete; the truck's own nav/ELD is
// the final word. One Overpass call per ~100 route miles, 10-minute
// server cache (bridge data barely changes).

import { z } from "zod";
import type { LatLng } from "@/lib/smart-path";
import { parseMaxHeight, type BridgeFeature } from "@/lib/smart-path-bridges";
import { corridorBboxes } from "./tomtom-traffic";

export class OverpassBridgesError extends Error {}

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
  features: BridgeFeature[];
}

const cache = new Map<string, CacheEntry>();

export function clearOverpassBridgesCache(): void {
  cache.clear();
}

export interface FetchBridgeFeaturesInput {
  fetchFn?: typeof fetch;
  /** Corridor points in route order. */
  points: LatLng[];
  now?: Date;
}

export async function fetchBridgeFeatures(input: FetchBridgeFeaturesInput): Promise<BridgeFeature[]> {
  const { fetchFn = fetch, points } = input;
  if (points.length === 0) return [];
  const bboxes = corridorBboxes(points, 100, 2).slice(0, MAX_BBOX_CALLS);
  const cacheKey = bboxes.map((b) => `${b.minLat.toFixed(3)},${b.minLng.toFixed(3)},${b.maxLat.toFixed(3)},${b.maxLng.toFixed(3)}`).join("|");
  const nowMs = (input.now ?? new Date()).getTime();
  const cached = cache.get(cacheKey);
  if (cached && nowMs - cached.at < CACHE_TTL_MS) return cached.features;

  const seen = new Set<string>();
  const features: BridgeFeature[] = [];
  for (const b of bboxes) {
    // Overpass bbox order: south,west,north,east.
    const query =
      `[out:json][timeout:25];` +
      `way["bridge"]["maxheight"](${b.minLat},${b.minLng},${b.maxLat},${b.maxLng});` +
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
      throw new OverpassBridgesError(
        `Overpass unreachable: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
    if (!response.ok) {
      throw new OverpassBridgesError(`Overpass answered HTTP ${response.status}.`);
    }
    const parsed = overpassResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new OverpassBridgesError("Overpass returned an unexpected response shape.");
    }
    for (const element of parsed.data.elements) {
      const lat = element.lat ?? element.center?.lat;
      const lng = element.lon ?? element.center?.lon;
      if (lat === undefined || lng === undefined) continue;
      const id = `${element.type}/${element.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const tags = element.tags ?? {};
      // Only bridges WITH a recorded clearance are ever shown.
      const maxHeightIn = tags.maxheight ? parseMaxHeight(tags.maxheight) : null;
      if (maxHeightIn === null) continue;
      features.push({
        id,
        point: { lat, lng },
        maxHeightIn,
        name: tags.name ?? null,
        road: tags.ref ?? tags.name ?? null,
      });
    }
  }
  cache.set(cacheKey, { at: nowMs, features });
  return features;
}
