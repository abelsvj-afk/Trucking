// Smart Path routing (docs/design/driver-mvp.md §8.1, §8.5).
// Routing sits behind a provider interface: Smart Path's planning
// code depends on RoutingProvider, never on a vendor. A chain of
// providers is tried in order (see defaultRoutingProvider):
//
//   1. OpenRouteService `driving-hgv` - truck-legal, free key tier.
//      Only in the chain when ORS_API_KEY is set; the key drops in
//      via env with zero code change (src/services/integrations/
//      openrouteservice.ts).
//   2. Valhalla `truck` costing on the public OpenStreetMap
//      endpoint - truck-legal and keyless, but a community demo
//      service, so it is a fallback, not the primary
//      (src/services/integrations/valhalla.ts).
//   3. OSRM public demo - keyless, but a CAR profile. Last resort;
//      its results carry truckLegal: false and the route check
//      restores the v1 car-route warnings verbatim.
//
// HONEST LIMITS (also in the design doc, repeated here so they can't
// be lost): "truck-legal" means the serving engine respected the
// truck restrictions RECORDED IN OPENSTREETMAP DATA (maxheight /
// maxweight / hgv access tags, plus the truck's own dimensions
// passed in). OSM restriction coverage is incomplete - a road with
// no recorded limit is treated as passable - so even a truckLegal
// route is checked-against-the-data-that-exists, not a guarantee,
// and the truck's own nav/ELD stays the final word. OSRM's public
// server is a demo service with fair-use limits. Every provider
// response is Zod-validated so a wrong assumption fails loudly
// instead of producing a plausible-looking wrong route. None of
// this is verified against a live call from this sandbox (outbound
// HTTPS is blocked here); verify once deployed, same as
// src/services/integrations/eia.ts.

import { z } from "zod";
import type { LatLng } from "@/lib/smart-path";
import { OpenRouteServiceRoutingProvider } from "@/services/integrations/openrouteservice";
import {
  DEFAULT_VALHALLA_URL,
  ValhallaRoutingProvider,
} from "@/services/integrations/valhalla";

/**
 * The truck's recorded dimensions (trucks table, §8.2), in the
 * units they're stored in. Every field is nullable - the profile is
 * captured by hand and may be partial. Providers receive only the
 * values that exist (converted); a missing dimension is never
 * invented. The profile has no width column, so width is not part
 * of this shape at all.
 */
export interface VehicleProfile {
  heightIn: number | null;
  lengthIn: number | null;
  weightLbs: number | null;
}

/** Dimensions in the meters / metric tons both truck engines take. */
export interface MetricRestrictions {
  heightMeters?: number;
  lengthMeters?: number;
  weightTons?: number;
}

const METERS_PER_INCH = 0.0254;
const TONS_PER_POUND = 0.00045359237;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function metricRestrictions(vehicle: VehicleProfile | null | undefined): MetricRestrictions {
  const restrictions: MetricRestrictions = {};
  if (!vehicle) return restrictions;
  if (vehicle.heightIn !== null) restrictions.heightMeters = round2(vehicle.heightIn * METERS_PER_INCH);
  if (vehicle.lengthIn !== null) restrictions.lengthMeters = round2(vehicle.lengthIn * METERS_PER_INCH);
  if (vehicle.weightLbs !== null) restrictions.weightTons = round2(vehicle.weightLbs * TONS_PER_POUND);
  return restrictions;
}

/**
 * One turn prompt, normalized across providers (Drive Mode D1,
 * G-6 enabler): the providers already return maneuvers - Valhalla
 * legs carry them, ORS returns them when asked, OSRM with steps -
 * and until now the schemas dropped them on the floor. Distances
 * are the length of the segment the instruction starts; atFraction
 * is where that segment begins along the whole route (0-1).
 */
export interface RouteManeuver {
  instruction: string;
  distanceMiles: number;
  atFraction: number;
}

/**
 * Builds the normalized maneuver list from per-segment lengths:
 * each segment's atFraction is the cumulative distance before it,
 * over the route total. Segments with no usable instruction are
 * dropped (an empty prompt is worse than none); a zero total
 * yields no maneuvers rather than NaN fractions.
 */
export function normalizeManeuvers(
  segments: { instruction: string; lengthMiles: number }[],
  totalMiles: number,
): RouteManeuver[] {
  if (!(totalMiles > 0)) return [];
  const maneuvers: RouteManeuver[] = [];
  let walked = 0;
  for (const segment of segments) {
    const instruction = segment.instruction.trim();
    if (instruction) {
      maneuvers.push({
        instruction,
        distanceMiles: Math.round(segment.lengthMiles * 100) / 100,
        atFraction: Math.min(1, walked / totalMiles),
      });
    }
    walked += segment.lengthMiles;
  }
  return maneuvers;
}

export interface RouteResult {
  distanceMiles: number;
  durationMinutes: number;
  /** [lng, lat] pairs converted to LatLng, in route order. */
  geometry: LatLng[];
  providerName: string;
  /**
   * Turn prompts for Drive Mode (G-6), when the serving provider
   * returned them. Optional and additive: planning ignores them,
   * and a route without maneuvers still Drives - next-stop
   * guidance only, and Drive says which it has.
   */
  maneuvers?: RouteManeuver[];
  /**
   * True only when a truck-aware engine (ORS driving-hgv or
   * Valhalla truck costing) actually served this route. A fallback
   * to the OSRM car profile returns false - the flag never upgrades
   * silently (design §8.5).
   */
  truckLegal: boolean;
  /**
   * Attribution/degradation notes from the provider chain (a
   * provider skipped for missing config, a provider that failed
   * before a fallback answered). Surfaced to the owner by the
   * route check; never used to carry numbers.
   */
  providerNotes: string[];
}

export interface RoutingProvider {
  readonly name: string;
  getRoute(from: LatLng, to: LatLng, vehicle?: VehicleProfile | null): Promise<RouteResult>;
}

export class RoutingUnavailableError extends Error {}

/**
 * Tries providers in order. A provider that fails with
 * RoutingUnavailableError degrades to the next one, and the
 * degradation is recorded in the result's providerNotes - loud,
 * never silent. Any other error propagates (it isn't a routing
 * outage). If every provider fails, the chain fails with the
 * combined reasons.
 */
export class ChainedRoutingProvider implements RoutingProvider {
  readonly name = "Routing provider chain";

  constructor(
    readonly providers: RoutingProvider[],
    readonly skipNotes: string[] = [],
  ) {}

  async getRoute(from: LatLng, to: LatLng, vehicle?: VehicleProfile | null): Promise<RouteResult> {
    const notes: string[] = [...this.skipNotes];
    const failures: string[] = [];
    for (const provider of this.providers) {
      try {
        const result = await provider.getRoute(from, to, vehicle);
        return { ...result, providerNotes: [...notes, ...result.providerNotes] };
      } catch (err) {
        if (!(err instanceof RoutingUnavailableError)) throw err;
        failures.push(`${provider.name}: ${err.message}`);
        notes.push(`${provider.name} could not serve this route (${err.message}) - fell back to the next provider.`);
      }
    }
    throw new RoutingUnavailableError(`No routing provider could serve this route. ${failures.join(" ")}`);
  }
}

/**
 * The production chain, built from env (design §8.5):
 * ORS (only with ORS_API_KEY - absent key = skipped, and the skip
 * is noted in every result until the key lands) -> Valhalla
 * (VALHALLA_URL or the public endpoint) -> OSRM car.
 */
export function defaultRoutingProvider(
  env: Record<string, string | undefined> = process.env,
): ChainedRoutingProvider {
  const providers: RoutingProvider[] = [];
  const skipNotes: string[] = [];

  const orsApiKey = env.ORS_API_KEY?.trim();
  if (orsApiKey) {
    providers.push(new OpenRouteServiceRoutingProvider(orsApiKey));
  } else {
    skipNotes.push(
      "OpenRouteService truck routing was skipped: ORS_API_KEY is not set. Set it as a Fly secret to make OpenRouteService the primary router.",
    );
  }

  providers.push(new ValhallaRoutingProvider(env.VALHALLA_URL?.trim() || DEFAULT_VALHALLA_URL));
  providers.push(new OsrmRoutingProvider());
  return new ChainedRoutingProvider(providers, skipNotes);
}

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
        // steps=true (Drive Mode G-6 enabler): OSRM returns no
        // ready-made instruction text, so the maneuver type +
        // modifier + street name are formatted locally below.
        legs: z
          .array(
            z.object({
              steps: z.array(
                z.object({
                  distance: z.number(), // meters
                  name: z.string().optional(),
                  maneuver: z.object({
                    type: z.string(),
                    modifier: z.string().optional(),
                  }),
                }),
              ),
            }),
          )
          .optional(),
      }),
    )
    .min(1, "OSRM returned no routes."),
});

/**
 * Formats one OSRM step as a spoken-style instruction from its
 * maneuver type/modifier and street name. Deliberately plain: this
 * text is what Drive displays and speaks, so it reads like a
 * direction, not a data dump.
 */
export function formatOsrmInstruction(step: {
  name?: string;
  maneuver: { type: string; modifier?: string };
}): string {
  const name = step.name?.trim();
  const onto = name ? ` onto ${name}` : "";
  const on = name ? ` on ${name}` : "";
  const { type, modifier } = step.maneuver;
  switch (type) {
    case "depart":
      return name ? `Head out on ${name}` : "Head out";
    case "arrive":
      return "Arrive at your destination";
    case "turn":
      return `Turn ${modifier ?? ""}${onto}`.replace(/\s+/g, " ").trim();
    case "new name":
      return `Continue${onto}`;
    case "continue":
      return `Continue${on}`;
    case "merge":
      return `Merge${onto}`;
    case "on ramp":
    case "off ramp":
      return `Take the ramp${onto}`;
    case "fork":
      return `Keep ${modifier ?? "straight"}${onto}`.replace(/\s+/g, " ").trim();
    case "end of road":
      return `At the end of the road, turn ${modifier ?? ""}${onto}`.replace(/\s+/g, " ").trim();
    case "roundabout":
    case "rotary":
      return `At the roundabout, take the exit${onto}`;
    default:
      return name ? `Continue on ${name}` : "Continue";
  }
}

const METERS_PER_MILE = 1609.344;
export const FETCH_TIMEOUT_MS = 15_000;

export class OsrmRoutingProvider implements RoutingProvider {
  readonly name = "OSRM (public demo, car profile)";

  // The vehicle profile is accepted to satisfy the interface and
  // deliberately unused: OSRM's driving profile is a car profile -
  // that is precisely why this provider's results are truckLegal:
  // false. There is no honest way to feed dimensions to it.
  async getRoute(from: LatLng, to: LatLng, _vehicle?: VehicleProfile | null): Promise<RouteResult> {
    void _vehicle;
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`;

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
    const distanceMiles = route.distance / METERS_PER_MILE;
    const steps = (route.legs ?? []).flatMap((leg) => leg.steps);
    return {
      distanceMiles,
      durationMinutes: route.duration / 60,
      geometry: route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
      providerName: this.name,
      truckLegal: false,
      providerNotes: [],
      ...(steps.length > 0
        ? {
            maneuvers: normalizeManeuvers(
              steps.map((step) => ({
                instruction: formatOsrmInstruction(step),
                lengthMiles: step.distance / METERS_PER_MILE,
              })),
              distanceMiles,
            ),
          }
        : {}),
    };
  }
}
