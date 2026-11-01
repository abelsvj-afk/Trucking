// Smart Path v1 (docs/design/driver-mvp.md §8.1). Places along a
// route, behind a provider interface; the implementation queries
// OpenStreetMap via the Overpass API - keyless.
//
// HONEST LIMITS: a place returned here is a place that exists in
// OpenStreetMap near the route - NOT a promise that a truck can park
// there, that it's open at the arrival hour, or (for fuel) what it
// charges. OSM rarely carries prices or hours for these. The UI
// labels candidates accordingly; nothing here invents a price, an
// hour, or truck access. Overpass failure degrades the section to
// "unavailable", never to fabricated stops.
//
// One Overpass call per route check, sampling a handful of points
// along the geometry - deliberately light against a shared public
// service. Not verified against a live call from this sandbox
// (outbound HTTPS blocked here); Zod-validated. Verify once deployed.

import { z } from "zod";
import type { LatLng } from "@/lib/smart-path";

export type PlaceKind = "fuel" | "grocery" | "fast_food";

export interface Place extends LatLng {
  id: string;
  name: string;
  kind: PlaceKind;
}

export interface PlacesProvider {
  readonly name: string;
  findNear(points: LatLng[], radiusMeters: number): Promise<Place[]>;
}

export class PlacesUnavailableError extends Error {}

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

const KIND_FILTERS: Record<PlaceKind, string> = {
  fuel: '["amenity"="fuel"]',
  grocery: '["shop"="supermarket"]',
  fast_food: '["amenity"="fast_food"]',
};

export class OverpassPlacesProvider implements PlacesProvider {
  readonly name = "OpenStreetMap (Overpass)";

  async findNear(points: LatLng[], radiusMeters: number): Promise<Place[]> {
    if (points.length === 0) return [];

    const clauses: string[] = [];
    for (const point of points) {
      for (const filter of Object.values(KIND_FILTERS)) {
        clauses.push(`node${filter}(around:${radiusMeters},${point.lat},${point.lng});`);
        clauses.push(`way${filter}(around:${radiusMeters},${point.lat},${point.lng});`);
      }
    }
    const query = `[out:json][timeout:20];(${clauses.join("")});out center 120;`;

    let response: Response;
    try {
      response = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        body: `data=${encodeURIComponent(query)}`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "TruckingOS-SmartPath/1.0 (route planning; single-owner app)",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new PlacesUnavailableError(
        `Places provider unreachable: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
    if (!response.ok) {
      throw new PlacesUnavailableError(`Places provider answered HTTP ${response.status}.`);
    }

    const parsed = overpassResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new PlacesUnavailableError("Places provider returned an unexpected response shape.");
    }

    const places: Place[] = [];
    const seen = new Set<string>();
    for (const element of parsed.data.elements) {
      const lat = element.lat ?? element.center?.lat;
      const lng = element.lon ?? element.center?.lon;
      if (lat === undefined || lng === undefined) continue;
      const tags = element.tags ?? {};
      const kind: PlaceKind | null =
        tags.amenity === "fuel"
          ? "fuel"
          : tags.amenity === "fast_food"
            ? "fast_food"
            : tags.shop === "supermarket"
              ? "grocery"
              : null;
      if (!kind) continue;
      const id = `${element.type}/${element.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const name =
        tags.name ?? tags.brand ?? (kind === "fuel" ? "Fuel station" : kind === "grocery" ? "Grocery store" : "Fast food");
      places.push({ id, name, kind, lat, lng });
    }
    return places;
  }
}
