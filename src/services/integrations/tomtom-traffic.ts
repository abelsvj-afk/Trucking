// Smart Path live awareness (owner 2026-11-17): live traffic
// incidents from the TomTom Traffic Incidents API v5.
//
// FREE TIER (verified 2026-11-17, developer.tomtom.com): 2,500
// non-tile transactions/day + 50,000 tile requests/day, no credit
// card, commercial use permitted. Key: TOMTOM_API_KEY (free
// registration) — same pattern as ORS_API_KEY. Absent key -> the
// section reports "unavailable", never invented traffic.
//
// HONEST LIMITS: TomTom knows reported incidents (accidents, jams,
// closures, road work) with a reported delay when one is measured.
// It does not know every slowdown, and an uncolored stretch means
// "no reported incident", never "clear". One call per ~60 route
// miles (bbox max 10,000 km2), 2-minute server cache, live polling
// covers only ~60-100 mi ahead — well under the free tier.

import { z } from "zod";
import { haversineMiles, type LatLng } from "@/lib/smart-path";
import type { TrafficIncident } from "@/lib/smart-path-traffic";

export class TomTomTrafficError extends Error {}

export function isTomTomConfigured(): boolean {
  return Boolean(process.env.TOMTOM_API_KEY);
}

export interface CorridorBbox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

/**
 * Splits corridor points into bbox chunks of at most `milesPerBox`
 * route miles, each expanded by `marginMiles` so an incident just
 * off the line still lands inside. Points must be in route order;
 * chunks come out nearest-first.
 */
export function corridorBboxes(
  points: LatLng[],
  milesPerBox = 60,
  marginMiles = 3,
): CorridorBbox[] {
  if (points.length === 0) return [];
  const chunks: LatLng[][] = [];
  let current: LatLng[] = [points[0]!];
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const step = haversineMiles(points[i - 1]!, points[i]!);
    if (walked + step > milesPerBox && current.length > 1) {
      chunks.push(current);
      current = [points[i - 1]!];
      walked = 0;
    }
    current.push(points[i]!);
    walked += step;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map((chunk) => {
    const lats = chunk.map((p) => p.lat);
    const lngs = chunk.map((p) => p.lng);
    const meanLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const latMargin = marginMiles / 69;
    const lngMargin = marginMiles / (69 * Math.max(0.2, Math.cos((meanLat * Math.PI) / 180)));
    return {
      minLat: Math.min(...lats) - latMargin,
      minLng: Math.min(...lngs) - lngMargin,
      maxLat: Math.max(...lats) + latMargin,
      maxLng: Math.max(...lngs) + lngMargin,
    };
  });
}

const tomtomResponseSchema = z.object({
  incidents: z
    .array(
      z.object({
        type: z.string(),
        geometry: z.object({
          type: z.string(),
          coordinates: z.unknown(),
        }),
        properties: z.object({
          id: z.string().optional(),
          iconCategory: z.number().optional(),
          magnitudeOfDelay: z.number().optional(),
          delay: z.number().optional(),
          events: z.array(z.object({ description: z.string().optional() })).optional(),
          startTime: z.string().optional(),
          endTime: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          length: z.number().optional(),
          roadNumbers: z.array(z.string()).optional(),
        }),
      }),
    )
    .optional(),
});

function toLatLngs(coordinates: unknown): LatLng[] {
  const asPairs = (value: unknown): [number, number][] => {
    if (!Array.isArray(value)) return [];
    if (typeof value[0] === "number") return [value as [number, number]];
    return (value as unknown[]).flatMap((v) => asPairs(v));
  };
  return asPairs(coordinates)
    .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat))
    .map(([lng, lat]) => ({ lat, lng }));
}

const FETCH_TIMEOUT_MS = 10_000;
/** Never more than this many bbox calls per route check — nearest first. */
export const MAX_BBOX_CALLS = 10;
const CACHE_TTL_MS = 120_000;

interface CacheEntry {
  at: number;
  incidents: TrafficIncident[];
}

const cache = new Map<string, CacheEntry>();

export function clearTomTomTrafficCache(): void {
  cache.clear();
}

export interface FetchTomTomIncidentsInput {
  fetchFn?: typeof fetch;
  apiKey: string;
  /** Corridor points in route order (the route geometry, or its corridor points). */
  points: LatLng[];
  now?: Date;
}

export async function fetchTomTomIncidents(input: FetchTomTomIncidentsInput): Promise<TrafficIncident[]> {
  const { fetchFn = fetch, apiKey, points } = input;
  if (!apiKey) throw new TomTomTrafficError("TomTom API key is not set (TOMTOM_API_KEY).");
  if (points.length === 0) return [];
  const bboxes = corridorBboxes(points).slice(0, MAX_BBOX_CALLS);
  const cacheKey = bboxes.map((b) => `${b.minLat.toFixed(3)},${b.minLng.toFixed(3)},${b.maxLat.toFixed(3)},${b.maxLng.toFixed(3)}`).join("|");
  const nowMs = (input.now ?? new Date()).getTime();
  const cached = cache.get(cacheKey);
  if (cached && nowMs - cached.at < CACHE_TTL_MS) return cached.incidents;

  const fields =
    "{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,delay,events{description},startTime,endTime,from,to,length,roadNumbers}}}";
  const seen = new Set<string>();
  const incidents: TrafficIncident[] = [];
  for (let i = 0; i < bboxes.length; i++) {
    const b = bboxes[i]!;
    const url =
      `https://api.tomtom.com/traffic/services/5/incidentDetails` +
      `?key=${encodeURIComponent(apiKey)}` +
      `&bbox=${b.minLng},${b.minLat},${b.maxLng},${b.maxLat}` +
      `&fields=${encodeURIComponent(fields)}` +
      `&language=en-US&timeValidityFilter=present`;
    let response: Response;
    try {
      response = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      throw new TomTomTrafficError(
        `TomTom traffic unreachable: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
    if (!response.ok) {
      throw new TomTomTrafficError(`TomTom traffic answered HTTP ${response.status}.`);
    }
    const parsed = tomtomResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new TomTomTrafficError("TomTom traffic returned an unexpected response shape.");
    }
    for (const raw of parsed.data.incidents ?? []) {
      const props = raw.properties;
      const id = props.id ?? `tomtom-${i}-${incidents.length}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const pointsOut = toLatLngs(raw.geometry.coordinates);
      if (pointsOut.length === 0) continue;
      const description = (props.events ?? [])
        .map((e) => e.description)
        .filter((d): d is string => Boolean(d))
        .join(" ");
      incidents.push({
        id,
        iconCategory: props.iconCategory ?? 0,
        description,
        points: pointsOut,
        delaySeconds: props.delay ?? null,
        magnitude: props.magnitudeOfDelay ?? 0,
        startTime: props.startTime ?? null,
        endTime: props.endTime ?? null,
        from: props.from ?? null,
        to: props.to ?? null,
        lengthMeters: props.length ?? null,
        roadNumbers: props.roadNumbers ?? [],
      });
    }
  }
  cache.set(cacheKey, { at: nowMs, incidents });
  return incidents;
}
