// Smart Path v1 (docs/design/driver-mvp.md §8.1). Routing behind a
// provider interface: Smart Path's planning code depends on
// RoutingProvider, never on a vendor. The only implementation is
// OSRM's public demo server - keyless, which is why it ships in v1.
//
// HONEST LIMITS (also in the design doc, repeated here so they can't
// be lost): router.project-osrm.org is a DEMO service with fair-use
// limits, and its driving profile is a CAR profile. Route geometry
// from it is NOT truck-legal - it does not enforce height/weight
// restrictions or truck-prohibited roads. The plan built on it takes
// its drive time from the slower of this estimate and the truck
// profile's speed math (src/lib/smart-path.ts), and the UI never
// calls the geometry truck-legal. A truck routing provider drops in
// behind this interface when one is chosen and keyed.
//
// Written from OSRM's documented API shape; the response is Zod-
// validated strictly so a wrong assumption fails loudly instead of
// producing a plausible-looking wrong route. Not verified against a
// live call from this sandbox (outbound HTTPS is blocked here);
// verify once deployed, same as src/services/integrations/eia.ts.

import { z } from "zod";
import type { LatLng } from "@/lib/smart-path";

export interface RouteResult {
  distanceMiles: number;
  durationMinutes: number;
  /** [lng, lat] pairs converted to LatLng, in route order. */
  geometry: LatLng[];
  providerName: string;
}

export interface RoutingProvider {
  readonly name: string;
  getRoute(from: LatLng, to: LatLng): Promise<RouteResult>;
}

export class RoutingUnavailableError extends Error {}

const osrmResponseSchema = z.object({
  code: z.string(),
  routes: z
    .array(
      z.object({
        distance: z.number(), // meters
        duration: z.number(), // seconds
        geometry: z.object({
          coordinates: z.array(z.tuple([z.number(), z.number()])),
        }),
      }),
    )
    .min(1, "OSRM returned no routes."),
});

const METERS_PER_MILE = 1609.344;
const FETCH_TIMEOUT_MS = 15_000;

export class OsrmRoutingProvider implements RoutingProvider {
  readonly name = "OSRM (public demo, car profile)";

  async getRoute(from: LatLng, to: LatLng): Promise<RouteResult> {
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;

    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": "TruckingOS-SmartPath/1.0 (route planning; single-owner app)" },
      });
    } catch (err) {
      throw new RoutingUnavailableError(
        `Routing provider unreachable: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
    if (!response.ok) {
      throw new RoutingUnavailableError(`Routing provider answered HTTP ${response.status}.`);
    }

    const parsed = osrmResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success || parsed.data.code !== "Ok") {
      throw new RoutingUnavailableError("Routing provider returned an unexpected response shape.");
    }

    const route = parsed.data.routes[0]!;
    return {
      distanceMiles: route.distance / METERS_PER_MILE,
      durationMinutes: route.duration / 60,
      geometry: route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
      providerName: this.name,
    };
  }
}
