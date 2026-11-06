// GET /api/v1/map/speed-limit?lat=&lng=&heading= - the posted limit (OSM `maxspeed`) for the
// road under the truck, or null (Block C). Authenticated; inputs validated; the Overpass
// call is server-side with a cache so a moving truck does not hammer the shared service.
// `limitMph: null` means "no limit data" or "unavailable" and the app shows NO badge -
// never an estimate.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { validationError } from "@/services/api/errors";
import { fetchSpeedLimit, SpeedLimitUnavailableError, type SpeedLimit } from "@/services/integrations/osm-speed";

const querySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  heading: z.coerce.number().min(0).max(360).optional(),
});

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; value: SpeedLimit | null }>();

/** ~55 m cells and 45-degree heading buckets: the same stretch of road answers from the cache. */
function cacheKey(lat: number, lng: number, heading: number | undefined): string {
  const bucket = heading === undefined ? "x" : String(Math.round(heading / 45) % 8);
  return `${lat.toFixed(3)}:${lng.toFixed(3)}:${bucket}`;
}

export const GET = createApiHandler(async (req: NextRequest) => {
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) throw validationError("lat and lng are required numbers.");
  const { lat, lng, heading } = parsed.data;
  const key = cacheKey(lat, lng, heading);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return NextResponse.json({ data: { limitMph: hit.value?.mph ?? null, roadName: hit.value?.roadName ?? null, unavailable: false, source: "OpenStreetMap" } });
  }
  try {
    const value = await fetchSpeedLimit({ lat, lng }, heading ?? null);
    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(key, { at: Date.now(), value });
    return NextResponse.json({ data: { limitMph: value?.mph ?? null, roadName: value?.roadName ?? null, unavailable: false, source: "OpenStreetMap" } });
  } catch (err) {
    if (err instanceof SpeedLimitUnavailableError) {
      return NextResponse.json({ data: { limitMph: null, roadName: null, unavailable: true, source: "OpenStreetMap" } });
    }
    throw err;
  }
});
