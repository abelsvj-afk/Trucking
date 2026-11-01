// Smart Path truck routing, keyless fallback (docs/design/
// driver-mvp.md §8.5). Valhalla's `truck` costing on the public
// OpenStreetMap endpoint run by FOSSGIS (valhalla1.openstreetmap.de):
// truck costing checks truck access plus height/width/weight limits
// recorded in OpenStreetMap data, with the truck's own dimensions
// passed as `costing_options.truck` (meters / metric tons).
//
// WHY FALLBACK AND NOT PRIMARY: the endpoint is a community demo
// service - free and keyless, but with no published quota or SLA.
// It earns its place in the chain because it makes routing
// truck-legal even before the free OpenRouteService key lands;
// VALHALLA_URL can point this client at any Valhalla instance
// (including a self-hosted one) later.
//
// Written from Valhalla's documented turn-by-turn API shape; the
// response is Zod-validated strictly and the encoded shape
// (polyline, 1e6 precision) is decoded locally. Not verified
// against a live call from this sandbox (outbound HTTPS is blocked
// here); verify once deployed, same as
// src/services/integrations/eia.ts.

import { z } from "zod";
import type { LatLng } from "@/lib/smart-path";
import {
  FETCH_TIMEOUT_MS,
  metricRestrictions,
  RoutingUnavailableError,
  type RouteResult,
  type RoutingProvider,
  type VehicleProfile,
} from "@/services/integrations/routing";

export const DEFAULT_VALHALLA_URL = "https://valhalla1.openstreetmap.de/route";

const valhallaResponseSchema = z.object({
  trip: z.object({
    status: z.number().optional(),
    summary: z.object({
      length: z.number(), // miles (directions_options.units = "miles")
      time: z.number(), // seconds
    }),
    legs: z
      .array(
        z.object({
          shape: z.string(), // encoded polyline, 1e6 precision
        }),
      )
      .min(1, "Valhalla returned no legs."),
  }),
});

/**
 * Decodes Valhalla's shape strings: standard polyline encoding at
 * 1e6 precision (Valhalla uses 6 decimal digits, not Google's 5).
 * Exported for direct unit tests - a precision mistake here would
 * put every point a factor of ten off, quietly.
 */
export function decodeValhallaShape(shape: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  const readDelta = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= shape.length) throw new Error("Valhalla shape ended mid-value.");
      byte = shape.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < shape.length) {
    lat += readDelta();
    lng += readDelta();
    points.push({ lat: lat / 1e6, lng: lng / 1e6 });
  }
  return points;
}

interface ValhallaTruckOptions {
  height?: number;
  length?: number;
  weight?: number;
}

export class ValhallaRoutingProvider implements RoutingProvider {
  readonly name = "Valhalla (truck costing, public OpenStreetMap endpoint)";

  constructor(private readonly url: string = DEFAULT_VALHALLA_URL) {}

  async getRoute(from: LatLng, to: LatLng, vehicle?: VehicleProfile | null): Promise<RouteResult> {
    const metric = metricRestrictions(vehicle);
    const truck: ValhallaTruckOptions = {};
    if (metric.heightMeters !== undefined) truck.height = metric.heightMeters;
    if (metric.lengthMeters !== undefined) truck.length = metric.lengthMeters;
    if (metric.weightTons !== undefined) truck.weight = metric.weightTons;

    const body: Record<string, unknown> = {
      locations: [
        { lat: from.lat, lon: from.lng },
        { lat: to.lat, lon: to.lng },
      ],
      costing: "truck",
      directions_options: { units: "miles" },
    };
    if (Object.keys(truck).length > 0) {
      body.costing_options = { truck };
    }

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "TruckingOS-SmartPath/1.0 (route planning; single-owner app)",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new RoutingUnavailableError(
        `Valhalla unreachable: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
    if (!response.ok) {
      throw new RoutingUnavailableError(`Valhalla answered HTTP ${response.status}.`);
    }

    const parsed = valhallaResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new RoutingUnavailableError("Valhalla returned an unexpected response shape.");
    }
    if (parsed.data.trip.status !== undefined && parsed.data.trip.status !== 0) {
      throw new RoutingUnavailableError(`Valhalla reported trip status ${parsed.data.trip.status}.`);
    }

    let geometry: LatLng[];
    try {
      geometry = parsed.data.trip.legs.flatMap((leg, legIndex) => {
        const points = decodeValhallaShape(leg.shape);
        // Consecutive legs share their joint point; don't duplicate it.
        return legIndex === 0 ? points : points.slice(1);
      });
    } catch (err) {
      throw new RoutingUnavailableError(
        `Valhalla returned an undecodable route shape: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
    if (geometry.length === 0) {
      throw new RoutingUnavailableError("Valhalla returned an empty route shape.");
    }

    return {
      distanceMiles: parsed.data.trip.summary.length,
      durationMinutes: parsed.data.trip.summary.time / 60,
      geometry,
      providerName: this.name,
      truckLegal: true,
      providerNotes: [],
    };
  }
}
