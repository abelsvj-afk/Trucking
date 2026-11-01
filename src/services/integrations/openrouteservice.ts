// Smart Path truck routing, primary provider (docs/design/
// driver-mvp.md §8.5). OpenRouteService's `driving-hgv` profile:
// an HGV-aware routing graph (truck road-access filtering) plus the
// truck's own dimensions as `profile_params.restrictions` - length/
// width/height in meters, weight in metric tons, per the ORS
// routing-options documentation.
//
// COST: free Standard plan - 2,000 directions requests/day, 40/min,
// published on openrouteservice.org's plans page. This app runs a
// handful of route checks a day. The key is FREE and drops in via
// the ORS_API_KEY env var (Fly secret) with zero code change; with
// no key set, this provider is simply not in the chain (see
// defaultRoutingProvider in routing.ts) and the skip is noted.
//
// Written from ORS's documented API shape (POST /v2/directions/
// driving-hgv/geojson); the response is Zod-validated strictly so a
// wrong assumption fails loudly. Not verified against a live call
// from this sandbox (outbound HTTPS is blocked here); verify once
// deployed, same as src/services/integrations/eia.ts.

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

const ORS_DIRECTIONS_URL = "https://api.openrouteservice.org/v2/directions/driving-hgv/geojson";
const METERS_PER_MILE = 1609.344;

const orsResponseSchema = z.object({
  features: z
    .array(
      z.object({
        properties: z.object({
          summary: z.object({
            distance: z.number(), // meters
            duration: z.number(), // seconds
          }),
        }),
        geometry: z.object({
          coordinates: z.array(z.tuple([z.number(), z.number()])), // [lng, lat]
        }),
      }),
    )
    .min(1, "OpenRouteService returned no routes."),
});

interface OrsRestrictions {
  length?: number;
  height?: number;
  weight?: number;
}

export class OpenRouteServiceRoutingProvider implements RoutingProvider {
  readonly name = "OpenRouteService (driving-hgv truck profile)";

  constructor(private readonly apiKey: string) {}

  async getRoute(from: LatLng, to: LatLng, vehicle?: VehicleProfile | null): Promise<RouteResult> {
    const metric = metricRestrictions(vehicle);
    const restrictions: OrsRestrictions = {};
    if (metric.lengthMeters !== undefined) restrictions.length = metric.lengthMeters;
    if (metric.heightMeters !== undefined) restrictions.height = metric.heightMeters;
    if (metric.weightTons !== undefined) restrictions.weight = metric.weightTons;

    const options: Record<string, unknown> = { vehicle_type: "hgv" };
    if (Object.keys(restrictions).length > 0) {
      options.profile_params = { restrictions };
    }

    let response: Response;
    try {
      response = await fetch(ORS_DIRECTIONS_URL, {
        method: "POST",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          Authorization: this.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "TruckingOS-SmartPath/1.0 (route planning; single-owner app)",
        },
        body: JSON.stringify({
          coordinates: [
            [from.lng, from.lat],
            [to.lng, to.lat],
          ],
          options,
        }),
      });
    } catch (err) {
      throw new RoutingUnavailableError(
        `OpenRouteService unreachable: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
    if (!response.ok) {
      throw new RoutingUnavailableError(
        response.status === 401 || response.status === 403
          ? `OpenRouteService rejected the API key (HTTP ${response.status}).`
          : `OpenRouteService answered HTTP ${response.status}.`,
      );
    }

    const parsed = orsResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new RoutingUnavailableError("OpenRouteService returned an unexpected response shape.");
    }

    const feature = parsed.data.features[0]!;
    return {
      distanceMiles: feature.properties.summary.distance / METERS_PER_MILE,
      durationMinutes: feature.properties.summary.duration / 60,
      geometry: feature.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
      providerName: this.name,
      truckLegal: true,
      providerNotes: [],
    };
  }
}
