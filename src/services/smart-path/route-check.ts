// Smart Path v1 orchestration (docs/design/driver-mvp.md §8.3;
// truck-legal routing §8.5). Loads the owner's own records (load,
// duty logs, truck profile, fuel history), calls the providers
// behind their interfaces (the truck profile is fetched first - its
// dimensions are inputs to the truck-aware routing chain), and
// runs the deterministic verdict in src/lib/smart-path.ts. No AI is
// involved and no number is produced anywhere but the lib or a real
// query - a provider failure surfaces as an honest error or an
// "unavailable" section, never as an invented figure.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "@/services/api/errors";
import { summarizeHos, type DutySegmentInput } from "@/lib/hos";
import {
  checkRoute,
  clocksFromHos,
  distanceToRouteMiles,
  elapsedAtDrivenMinutes,
  pointAlongRoute,
  routeFractionOfPoint,
  type LatLng,
} from "@/lib/smart-path";
import {
  DEFAULT_FUEL_ASSUMPTIONS,
  planFoodStops,
  rankFuelCandidates,
  type FoodCandidate,
  type FuelCandidate,
} from "@/lib/smart-path-stops";
import {
  GeocodingUnavailableError,
  NominatimGeocodingProvider,
  type GeocodingProvider,
} from "@/services/integrations/geocoding";
import {
  defaultRoutingProvider,
  RoutingUnavailableError,
  type RoutingProvider,
  type VehicleProfile,
} from "@/services/integrations/routing";
import {
  OverpassPlacesProvider,
  PlacesUnavailableError,
  type Place,
  type PlacesProvider,
} from "@/services/integrations/places";
import type { RouteCheckRequest } from "@/data/schemas/smart-path";
import type { DutyLog, FuelPurchase, Load, Truck } from "@/types/entities";
import type { RouteCheckResponse } from "@/types/smart-path";

export interface RouteCheckProviders {
  geocoding: GeocodingProvider;
  routing: RoutingProvider;
  places: PlacesProvider;
}

export const defaultProviders: RouteCheckProviders = {
  geocoding: new NominatimGeocodingProvider(),
  routing: defaultRoutingProvider(),
  places: new OverpassPlacesProvider(),
};

const EIGHT_DAYS_MS = 8 * 24 * 60 * 60_000;
const CORRIDOR_MILES = 25; // history locations further than this from the route aren't candidates
const PLACES_RADIUS_METERS = 5000;
const DEFAULT_GALLONS_TO_BUY = 100;
const DEFAULT_AVG_MPG = 6.5;

function samplePoints(geometry: LatLng[], count: number): LatLng[] {
  const points: LatLng[] = [];
  for (let i = 0; i < count; i++) {
    const point = pointAlongRoute(geometry, count === 1 ? 0 : i / (count - 1));
    if (point) points.push(point);
  }
  return points;
}

export async function runRouteCheck(
  supabase: SupabaseClient,
  request: RouteCheckRequest,
  providers: RouteCheckProviders = defaultProviders,
  now: Date = new Date(),
  // §13: the web endpoint's session client is scoped by RLS, but the
  // agent tool runs this engine on the Telegram surface's
  // service-role client, where RLS does not apply — so a caller with
  // an unscoped client passes its company id and every read below
  // is filtered by it in code. Null (the endpoint's call) keeps the
  // original RLS-only behavior untouched.
  companyId: string | null = null,
): Promise<RouteCheckResponse> {
  const warnings: string[] = [];

  let loadQuery = supabase
    .from("loads")
    .select("*")
    .eq("id", request.load_id)
    .is("deleted_at", null);
  if (companyId) loadQuery = loadQuery.eq("company_id", companyId);
  const { data: loadData, error: loadError } = await loadQuery.maybeSingle();
  if (loadError) throw new Error(loadError.message);
  if (!loadData) throw new ApiError(404, "NOT_FOUND", "That load could not be found.");
  const load = loadData as Load;

  // --- geocode + route -------------------------------------------------
  let originPoint: LatLng | null;
  let destinationPoint: LatLng | null;
  try {
    originPoint = await providers.geocoding.geocode(load.origin);
    destinationPoint = await providers.geocoding.geocode(load.destination);
  } catch (err) {
    if (err instanceof GeocodingUnavailableError) {
      throw new ApiError(502, "GEOCODING_UNAVAILABLE", err.message);
    }
    throw err;
  }
  if (!originPoint) {
    throw new ApiError(
      400,
      "GEOCODE_MISS",
      `Couldn't find "${load.origin}" on the map. Edit the load's origin to a fuller address or city/state and try again.`,
    );
  }
  if (!destinationPoint) {
    throw new ApiError(
      400,
      "GEOCODE_MISS",
      `Couldn't find "${load.destination}" on the map. Edit the load's destination to a fuller address or city/state and try again.`,
    );
  }

  // --- the truck profile (fetched before routing: its dimensions ---
  // --- are inputs to the truck-aware routing engines, §8.5) ---------
  let truck: Truck | null = null;
  if (load.truck_id) {
    let truckQuery = supabase
      .from("trucks")
      .select("*")
      .eq("id", load.truck_id)
      .is("deleted_at", null);
    if (companyId) truckQuery = truckQuery.eq("company_id", companyId);
    const { data } = await truckQuery.maybeSingle();
    truck = (data as Truck | null) ?? null;
  }
  if (truck && (truck.height_in === null || truck.weight_lbs === null)) {
    warnings.push(
      "This truck's profile has no height/weight captured yet - add it under Fleet → Truck profile so truck routing can check those exact restrictions instead of the engines' generic truck limits.",
    );
  }
  const vehicle: VehicleProfile | null = truck
    ? { heightIn: truck.height_in, lengthIn: truck.length_in, weightLbs: truck.weight_lbs }
    : null;

  let route;
  try {
    route = await providers.routing.getRoute(originPoint, destinationPoint, vehicle);
  } catch (err) {
    if (err instanceof RoutingUnavailableError) {
      throw new ApiError(502, "ROUTING_UNAVAILABLE", `${err.message} No distance was estimated instead - a made-up number would be worse than none.`);
    }
    throw err;
  }
  // Chain attribution/degradation notes are part of the answer, not
  // fine print: which engine answered and what was skipped or fell
  // back is stated to the owner (§8.5).
  warnings.push(...route.providerNotes);
  if (route.truckLegal) {
    warnings.push(
      `Route geometry came from ${route.providerName} - a truck routing engine that applies the truck restrictions recorded in OpenStreetMap data (height/weight limits, truck-prohibited roads)${vehicle ? " plus this truck's captured dimensions where the map records a limit" : ""}. OpenStreetMap's restriction data is incomplete: a road with no recorded limit is treated as passable, so check the route against the truck's own nav/ELD before rolling.`,
    );
  } else {
    warnings.push(
      "Route geometry is a standard car route (OSRM) in this version - it is NOT checked against truck height/weight restrictions or truck-prohibited roads. Check it against the truck's own nav/ELD before rolling.",
    );
  }

  // --- his clocks -------------------------------------------------------
  let dutyQuery = supabase
    .from("duty_logs")
    .select("duty_status, started_at")
    .is("deleted_at", null)
    .gte("started_at", new Date(now.getTime() - EIGHT_DAYS_MS).toISOString());
  if (companyId) dutyQuery = dutyQuery.eq("company_id", companyId);
  const { data: dutyData, error: dutyError } = await dutyQuery.order("started_at", {
    ascending: true,
  });
  if (dutyError) throw new Error(dutyError.message);
  const hos = summarizeHos((dutyData ?? []) as DutySegmentInput[], now);
  const clocks = clocksFromHos(hos);

  const departAt = new Date(request.depart_at);
  const verdict = checkRoute({
    now,
    departAt,
    distanceMiles: route.distanceMiles,
    providerDurationMinutes: route.durationMinutes,
    clocks,
    governedSpeedMph: truck?.governed_speed_mph ?? null,
    pickupWindow: request.pickup_window ?? null,
    deliveryWindow: request.delivery_window ?? null,
    rateCents: load.rate_cents,
    loadMiles: load.miles,
  });
  warnings.push(...verdict.warnings);

  const plan = verdict.plan;
  const restsWithPoints = (plan?.rests ?? []).map((rest) => ({
    ...rest,
    point: pointAlongRoute(route.geometry, rest.fractionOfRoute),
  }));

  // --- places along the route (fuel + food share one lookup) ------------
  let places: Place[] = [];
  let placesUnavailable: string | null = null;
  try {
    places = await providers.places.findNear(samplePoints(route.geometry, 5), PLACES_RADIUS_METERS);
  } catch (err) {
    placesUnavailable =
      err instanceof PlacesUnavailableError
        ? err.message
        : "Places lookup failed unexpectedly - stops are unavailable for this check.";
  }

  // --- fuel: his history near the corridor + map stations ---------------
  let fuelQuery = supabase.from("fuel_purchases").select("*").is("deleted_at", null);
  if (companyId) fuelQuery = fuelQuery.eq("company_id", companyId);
  const { data: fuelData, error: fuelError } = await fuelQuery
    .order("purchased_at", { ascending: false })
    .limit(200);
  if (fuelError) throw new Error(fuelError.message);
  const purchases = (fuelData ?? []) as FuelPurchase[];

  const byLocation = new Map<string, { totalCents: number; count: number }>();
  for (const purchase of purchases) {
    if (!purchase.location) continue;
    const entry = byLocation.get(purchase.location) ?? { totalCents: 0, count: 0 };
    entry.totalCents += purchase.price_per_gallon_cents;
    entry.count += 1;
    byLocation.set(purchase.location, entry);
  }
  const baselinePriceCents =
    purchases.length > 0
      ? Math.round(purchases.reduce((sum, p) => sum + p.price_per_gallon_cents, 0) / purchases.length)
      : null;

  const fuelCandidates: FuelCandidate[] = [];
  for (const [location, agg] of [...byLocation.entries()].slice(0, 10)) {
    const point = await providers.geocoding.geocode(location).catch(() => null);
    if (!point) continue;
    const offRoute = distanceToRouteMiles(point, route.geometry);
    if (offRoute > CORRIDOR_MILES) continue;
    fuelCandidates.push({
      id: `history:${location}`,
      name: location,
      lat: point.lat,
      lng: point.lng,
      pricePerGallonCents: Math.round(agg.totalCents / agg.count),
      source: "history",
      detourMiles: Math.round(offRoute * 2 * 10) / 10,
    });
  }
  for (const place of places) {
    if (place.kind !== "fuel") continue;
    fuelCandidates.push({
      id: place.id,
      name: place.name,
      lat: place.lat,
      lng: place.lng,
      pricePerGallonCents: null,
      source: "map",
      detourMiles: Math.round(distanceToRouteMiles(place, route.geometry) * 2 * 10) / 10,
    });
  }

  const avgMpg = truck?.avg_mpg ?? DEFAULT_AVG_MPG;
  if (!truck?.avg_mpg) {
    warnings.push(
      `Fuel math uses a default ${DEFAULT_AVG_MPG} mpg - set the truck's real average in Fleet → Truck profile and the fuel ranking sharpens.`,
    );
  }
  const gallonsToBuy =
    request.gallons_to_buy ?? (truck?.tank_capacity_gallons ? Math.round(truck.tank_capacity_gallons / 2) : DEFAULT_GALLONS_TO_BUY);
  const rankedFuel = rankFuelCandidates(
    fuelCandidates,
    { ...DEFAULT_FUEL_ASSUMPTIONS, gallonsToBuy, avgMpg },
    baselinePriceCents,
  ).slice(0, 6);

  // --- food ---------------------------------------------------------------
  const foodCandidates: FoodCandidate[] = [];
  if (plan?.feasible) {
    for (const place of places) {
      if (place.kind === "fuel") continue;
      const fraction = routeFractionOfPoint(place, route.geometry);
      const drivenMinutes = fraction * verdict.assumedDriveMinutes;
      const arrivalMs = departAt.getTime() + elapsedAtDrivenMinutes(plan, drivenMinutes) * 60_000;
      foodCandidates.push({
        id: place.id,
        name: place.name,
        kind: place.kind,
        lat: place.lat,
        lng: place.lng,
        detourMiles: Math.round(distanceToRouteMiles(place, route.geometry) * 2 * 10) / 10,
        arrivalAt: new Date(arrivalMs).toISOString(),
      });
    }
  }
  const foodPlan = planFoodStops(foodCandidates, request.food_mode, truck?.appliances ?? []);

  return {
    load: { id: load.id, origin: load.origin, destination: load.destination, status: load.status },
    route: {
      provider: route.providerName,
      truckLegal: route.truckLegal,
      distanceMiles: Math.round(route.distanceMiles * 10) / 10,
      providerDurationMinutes: Math.round(route.durationMinutes),
      geometry: route.geometry,
      originPoint,
      destinationPoint,
    },
    verdict: {
      status: verdict.status,
      assumedDriveMinutes: Math.round(verdict.assumedDriveMinutes),
      driveTimeBasis: verdict.driveTimeBasis,
      legalLines: verdict.legalLines,
      restedLines: verdict.restedLines,
      paidLines: verdict.paidLines,
      tradeoffLines: verdict.tradeoffLines,
      makeItDepartureAt: verdict.makeItDepartureAt,
    },
    plan: plan
      ? {
          arrivalAt: plan.arrivalAt,
          totalElapsedMinutes: Math.round(plan.totalElapsedMinutes),
          breaks: plan.breaks,
          rests: restsWithPoints,
        }
      : null,
    fuel: {
      assumptions: {
        gallonsToBuy,
        avgMpg,
        valueOfTimeCentsPerHour: DEFAULT_FUEL_ASSUMPTIONS.valueOfTimeCentsPerHour,
        stopMinutes: DEFAULT_FUEL_ASSUMPTIONS.stopMinutes,
        baselinePriceCents,
      },
      candidates: rankedFuel,
      unavailableReason: placesUnavailable && fuelCandidates.length === 0 ? placesUnavailable : null,
    },
    food: {
      mode: request.food_mode,
      groceryPlan: foodPlan.groceryPlan,
      stops: foodPlan.stops,
      suppressedByFast: foodPlan.suppressedByFast,
      lines: foodPlan.lines,
      unavailableReason: placesUnavailable,
    },
    warnings,
  };
}
