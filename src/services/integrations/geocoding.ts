// Smart Path v1 (docs/design/driver-mvp.md §8.1). Geocoding behind a
// provider interface; the implementation is Nominatim
// (OpenStreetMap's geocoder) - keyless, with a fair-use policy of at
// most ~1 request/second, which a single-owner route check respects
// by construction (two lookups per check, results cached in-process
// per query string for the life of the server process).
//
// Load origin/destination are free text the owner typed ("Melbourne,
// FL"); a miss is reported as a miss - the caller never invents
// coordinates. Not verified against a live call from this sandbox
// (outbound HTTPS blocked here); Zod-validated so a shape change
// fails loudly. Verify once deployed.

import { z } from "zod";
import type { LatLng } from "@/lib/smart-path";

export interface GeocodingProvider {
  readonly name: string;
  geocode(query: string): Promise<LatLng | null>;
}

export class GeocodingUnavailableError extends Error {}

const nominatimResponseSchema = z.array(
  z.object({
    lat: z.string(),
    lon: z.string(),
  }),
);

const FETCH_TIMEOUT_MS = 10_000;
const cache = new Map<string, LatLng | null>();

export class NominatimGeocodingProvider implements GeocodingProvider {
  readonly name = "Nominatim (OpenStreetMap)";

  async geocode(query: string): Promise<LatLng | null> {
    const key = query.trim().toLowerCase();
    if (cache.has(key)) return cache.get(key) ?? null;

    const url =
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=` +
      encodeURIComponent(query);

    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": "TruckingOS-SmartPath/1.0 (route planning; single-owner app)" },
      });
    } catch (err) {
      throw new GeocodingUnavailableError(
        `Geocoding provider unreachable: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
    if (!response.ok) {
      throw new GeocodingUnavailableError(`Geocoding provider answered HTTP ${response.status}.`);
    }

    const parsed = nominatimResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new GeocodingUnavailableError("Geocoding provider returned an unexpected response shape.");
    }

    const first = parsed.data[0];
    const result = first ? { lat: Number(first.lat), lng: Number(first.lon) } : null;
    if (result && (!Number.isFinite(result.lat) || !Number.isFinite(result.lng))) {
      throw new GeocodingUnavailableError("Geocoding provider returned non-numeric coordinates.");
    }
    cache.set(key, result);
    return result;
  }
}
