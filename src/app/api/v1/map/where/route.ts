// GET /api/v1/map/where?lat=&lng=&heading= - the drive map's "where am I" pill
// (owner 2026-11-19, TruckPath reference): road number, nearest mile marker,
// town and state. Authenticated; inputs validated; both lookups are free OSM
// services called server-side behind a cache (Nominatim allows one request a
// second — the coarse town grid keeps a rolling truck far under that). Any part
// that is unavailable comes back null and the pill shows only what is known.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { validationError } from "@/services/api/errors";
import { fetchPlaceHere, fetchRoadHere, type PlaceHere, type RoadHere } from "@/services/integrations/osm-where";

const querySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  heading: z.coerce.number().min(0).max(360).optional(),
});

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;
const roadCache = new Map<string, { at: number; value: RoadHere | null }>();
const placeCache = new Map<string, { at: number; value: PlaceHere }>();
let lastNominatimAtMs = 0;

function put<T>(cache: Map<string, { at: number; value: T }>, key: string, value: T) {
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, { at: Date.now(), value });
}

export const GET = createApiHandler(async (req: NextRequest) => {
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) throw validationError("lat and lng are required numbers.");
  const { lat, lng, heading } = parsed.data;
  const position = { lat, lng };

  // ~110 m cells + heading buckets for the road; ~5 km cells for the town.
  const roadKey = `${lat.toFixed(3)}:${lng.toFixed(3)}:${heading === undefined ? "x" : Math.round(heading / 45) % 8}`;
  const placeKey = `${lat.toFixed(2)}:${lng.toFixed(2)}`;

  let road: RoadHere | null = null;
  const roadHit = roadCache.get(roadKey);
  if (roadHit && Date.now() - roadHit.at < TTL_MS) road = roadHit.value;
  else {
    try {
      road = await fetchRoadHere(position, heading ?? null);
      put(roadCache, roadKey, road);
    } catch {
      road = null;
    }
  }

  let place: PlaceHere = { town: null, state: null };
  const placeHit = placeCache.get(placeKey);
  if (placeHit && Date.now() - placeHit.at < 6 * TTL_MS) place = placeHit.value;
  else if (Date.now() - lastNominatimAtMs >= 1_100) {
    lastNominatimAtMs = Date.now();
    try {
      place = await fetchPlaceHere(position);
      put(placeCache, placeKey, place);
    } catch {
      // unavailable: the pill shows the road alone
    }
  }

  return NextResponse.json({
    data: { roadRef: road?.ref ?? null, roadName: road?.name ?? null, mileMarker: road?.mileMarker ?? null, town: place.town, state: place.state, source: "OpenStreetMap" },
  });
});
