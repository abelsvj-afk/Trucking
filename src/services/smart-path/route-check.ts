// Smart Path v1 orchestration (docs/design/driver-mvp.md §8.3;
// truck-legal routing §8.5). Loads the owner's own records (load,
// duty logs, truck profile, fuel history), calls the providers
// behind their interfaces (the truck profile is fetched first - its
// dimensions are inputs to the truck-aware routing chain), and
// runs the deterministic verdict in src/lib/smart-path.ts. No AI is
// involved and no number is produced anywhere but the lib or a real
// query - a provider failure surfaces as an honest error or an
// "unavailable" section, never as an invented figure.

import { HOS_WINDOW_ROW_LIMIT, loadHosWindow, snapshotFromRows, type HosWindowSnapshot } from "@/services/api/hos-window";
import { PROVISIONAL_HOS_CONFIG } from "@/lib/hos-cycle";
import { hosCalculationWindowStartMs } from "@/lib/hos-periods";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "@/services/api/errors";
import type { DutySegmentInput } from "@/lib/hos";
import {
  checkRoute,
  clocksFromHos,
  distanceToRouteMiles,
  elapsedAtDrivenMinutes,
  plannedDriveMinutes,
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
import { getDieselPriceEstimate } from "@/services/smart-path/fuel-price-estimate";
import { hosProvenanceLines } from "@/services/fleet/paper-logs";
import type { RouteCheckRequest } from "@/data/schemas/smart-path";
import type { DutyLog, FuelPurchase, Load, Truck } from "@/types/entities";
import type { RouteCheckResponse } from "@/types/smart-path";

export interface RouteCheckProviders {
  geocoding: GeocodingProvider;
  routing: RoutingProvider;
  places: PlacesProvider;
  /** Piece 1 (P1-6): the EIA diesel estimate for map fuel candidates. */
  fuelPriceEstimate: () => Promise<{ cents: number; label: string } | null>;
}

export const defaultProviders: RouteCheckProviders = {
  geocoding: new NominatimGeocodingProvider(),
  routing: defaultRoutingProvider(),
  places: new OverpassPlacesProvider(),
  fuelPriceEstimate: () => getDieselPriceEstimate(),
};

type RouteResult = Awaited<ReturnType<RoutingProvider["getRoute"]>>;

/** Piece 1 (P1-9): a workout anchor candidate for the verdict lib -
 * a place near the route where a break could become a workout. */
interface WorkoutAnchor {
  name: string;
  kind: "gym" | "rest_area" | "parking" | "fuel_stop";
  drivenMinutes: number;
  point: LatLng;
}

const CORRIDOR_MILES = 25; // history locations further than this from the route aren't candidates
const PLACES_RADIUS_METERS = 5000;
const DEFAULT_GALLONS_TO_BUY = 100;
const DEFAULT_AVG_MPG = 6.5;

/** GAP-02: a load's stored appointment window as a TimeWindow (both ends or neither). */
function loadWindow(start: string | null, end: string | null) {
  return start && end ? { start, end } : null;
}

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
  // Reroute: the pickup is behind him; the run starts at his position.
  const pickedUp = Boolean(request.already_picked_up && request.start_point);
  try {
    originPoint = pickedUp ? (request.start_point as LatLng) : await providers.geocoding.geocode(load.origin);
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

  // --- the deadhead leg (Piece 1, P1-7): start -> pickup, routed ---
  // --- with the same provider chain and vehicle as the loaded leg --
  let startPoint: LatLng | null = null;
  let deadheadRoute: RouteResult | null = null;
  if (!pickedUp && (request.start_point || request.start_location)) {
    if (request.start_point) {
      startPoint = request.start_point;
    } else {
      try {
        startPoint = await providers.geocoding.geocode(request.start_location!);
      } catch (err) {
        if (err instanceof GeocodingUnavailableError) {
          throw new ApiError(502, "GEOCODING_UNAVAILABLE", err.message);
        }
        throw err;
      }
      if (!startPoint) {
        throw new ApiError(
          400,
          "GEOCODE_MISS",
          `Couldn't find "${request.start_location}" on the map. Give the start as a fuller address or city/state and try again.`,
        );
      }
    }
    try {
      deadheadRoute = await providers.routing.getRoute(startPoint, originPoint, vehicle);
    } catch (err) {
      if (err instanceof RoutingUnavailableError) {
        throw new ApiError(502, "ROUTING_UNAVAILABLE", `${err.message} No distance was estimated instead - a made-up number would be worse than none.`);
      }
      throw err;
    }
    // Degradations on this leg are stated, never silent - prefixed so
    // they can't be mistaken for notes about the loaded leg.
    warnings.push(...deadheadRoute.providerNotes.map((note) => `Deadhead: ${note}`));
  }

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
  if (pickedUp) {
    warnings.push("Rerouted from the truck's current position straight to the destination (the pickup is already behind you).");
  }
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
  // Provenance rides along when migration 00047 has landed (§7.7:
  // the math never changes - only the labeling). Pre-00047 the
  // wide select errors and the narrow one runs, unlabeled.
  // King review D-1: the same full-window read + carrier-cycle engine
  // as every other surface. With a company id (both real callers) the
  // carrier's settings apply; the RLS-only path uses the labeled
  // provisional defaults over the same window.
  let hosSnapshot: HosWindowSnapshot;
  if (companyId) {
    hosSnapshot = await loadHosWindow(supabase, companyId, now);
  } else {
    const since = new Date(hosCalculationWindowStartMs(now.getTime(), PROVISIONAL_HOS_CONFIG)).toISOString();
    const { data: dutyData, error: dutyError } = await supabase
      .from("duty_logs")
      .select("*")
      .is("deleted_at", null)
      .gte("started_at", since)
      .order("started_at", { ascending: true })
      .limit(HOS_WINDOW_ROW_LIMIT + 1);
    if (dutyError) throw new Error(dutyError.message);
    if ((dutyData ?? []).length > HOS_WINDOW_ROW_LIMIT) throw new Error("HOS window too large to compute completely.");
    hosSnapshot = snapshotFromRows((dutyData ?? []) as DutyLog[], PROVISIONAL_HOS_CONFIG, now);
  }
  const dutyRows = hosSnapshot.rows as (DutySegmentInput & {
    source?: string | null;
    source_document_id?: string | null;
  })[];
  const hos = hosSnapshot.short;
  const clocks = clocksFromHos(
    hos,
    hosSnapshot.cycle.cycleLimitMinutes - hosSnapshot.cycle.onDutyMinutesInCycle,
  );
  if (hosSnapshot.provisional) {
    warnings.push(
      `The week clock uses the provisional carrier settings (${hosSnapshot.cycle.cycle}, period start ${hosSnapshot.cycle.periodAnchor}) - set your carrier's real rules in Settings.`,
    );
  }
  // Trust labeling (§7.7.1): clocks built on paper rows say so,
  // and a partial paper day says partial - a route check that
  // would be illegal on the readable portion says illegal, never
  // "probably fine", and the label is how he knows which it is.
  warnings.push(...(await hosProvenanceLines(supabase, companyId ?? "", dutyRows)));

  const departAt = new Date(request.depart_at);

  // --- places along the route (fuel, food and workout anchors share ---
  // --- one lookup; 9 samples so stops between the old 5 points on ---
  // --- a long corridor are no longer invisible - Piece 1, P1-8) -----
  let places: Place[] = [];
  let placesUnavailable: string | null = null;
  try {
    places = await providers.places.findNear(samplePoints(route.geometry, 9), PLACES_RADIUS_METERS);
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
      // His logged price is a real price - it supersedes any estimate.
      estimatedPricePerGallonCents: null,
      estimateLabel: null,
      source: "history",
      detourMiles: Math.round(offRoute * 2 * 10) / 10,
    });
  }
  // Piece 1 (P1-6): one EIA estimate per check, attached to the map
  // candidates that have no real price. Belt-and-braces try/catch -
  // the estimate module already never throws, and a legacy provider
  // stub without this seam must degrade to null too, never break
  // the check.
  let estimate: { cents: number; label: string } | null = null;
  try {
    estimate = await providers.fuelPriceEstimate();
  } catch {
    estimate = null;
  }
  for (const place of places) {
    if (place.kind !== "fuel") continue;
    fuelCandidates.push({
      id: place.id,
      name: place.name,
      lat: place.lat,
      lng: place.lng,
      pricePerGallonCents: null,
      estimatedPricePerGallonCents: estimate?.cents ?? null,
      estimateLabel: estimate?.label ?? null,
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

  // --- workout anchors (Piece 1, P1-9): only when a workout was -----
  // --- requested. Anchor timing uses the lib's own planned-minutes --
  // --- rule so the service and the verdict agree exactly. -----------
  let workoutAnchors: WorkoutAnchor[] | undefined;
  if (request.life?.workout?.want) {
    const plannedMinutes = plannedDriveMinutes(
      route.distanceMiles,
      route.durationMinutes,
      truck?.governed_speed_mph ?? null,
    );
    workoutAnchors = [];
    for (const place of places) {
      if (place.kind !== "gym" && place.kind !== "rest_area") continue;
      workoutAnchors.push({
        name: place.name,
        kind: place.kind,
        drivenMinutes: routeFractionOfPoint(place, route.geometry) * plannedMinutes,
        point: { lat: place.lat, lng: place.lng },
      });
    }
    const topFuel = rankedFuel[0];
    if (topFuel) {
      workoutAnchors.push({
        name: topFuel.name,
        kind: "fuel_stop",
        drivenMinutes: routeFractionOfPoint(topFuel, route.geometry) * plannedMinutes,
        point: { lat: topFuel.lat, lng: topFuel.lng },
      });
    }
  }

  // --- the verdict ------------------------------------------------------
  const verdict = checkRoute({
    now,
    departAt,
    distanceMiles: route.distanceMiles,
    providerDurationMinutes: route.durationMinutes,
    clocks,
    governedSpeedMph: truck?.governed_speed_mph ?? null,
    // GAP-02: windows captured on the load (from the rate con at
    // intake) pre-fill the check — a window typed into the request
    // still wins, but he never re-types what the load already knows.
    pickupWindow: request.pickup_window ?? loadWindow(load.pickup_window_start, load.pickup_window_end),
    deliveryWindow:
      request.delivery_window ?? loadWindow(load.delivery_window_start, load.delivery_window_end),
    rateCents: load.rate_cents,
    loadMiles: load.miles,
    ...(deadheadRoute && startPoint
      ? {
          preLeg: {
            distanceMiles: deadheadRoute.distanceMiles,
            providerDurationMinutes: deadheadRoute.durationMinutes,
            startAt: request.start_at ? new Date(request.start_at) : null,
            startLabel: request.start_location ?? "Your current location",
          },
        }
      : {}),
    ...(request.life
      ? {
          life: {
            ...(request.life.sleep_start_hour !== undefined
              ? { sleepStartHour: request.life.sleep_start_hour }
              : {}),
            ...(request.life.sleep_end_hour !== undefined
              ? { sleepEndHour: request.life.sleep_end_hour }
              : {}),
            ...(request.life.workout ? { workout: request.life.workout } : {}),
          },
        }
      : {}),
    ...(workoutAnchors ? { workoutAnchors } : {}),
  });
  warnings.push(...verdict.warnings);

  const plan = verdict.plan;
  // Rest points: without a deadhead this is exactly the old mapping -
  // fraction of the loaded route. With one, rests are fractions of
  // the COMBINED route, and a rest early enough lands on the
  // deadhead geometry instead (Piece 1, P1-7).
  const combinedDistance = route.distanceMiles + (deadheadRoute?.distanceMiles ?? 0);
  const restsWithPoints = (plan?.rests ?? []).map((rest) => {
    const drivenMiles = rest.fractionOfRoute * combinedDistance;
    const point =
      deadheadRoute && drivenMiles < deadheadRoute.distanceMiles
        ? pointAlongRoute(deadheadRoute.geometry, drivenMiles / deadheadRoute.distanceMiles)
        : pointAlongRoute(
            route.geometry,
            (drivenMiles - (deadheadRoute?.distanceMiles ?? 0)) / route.distanceMiles,
          );
    return { ...rest, point };
  });

  // --- food ---------------------------------------------------------------
  const foodCandidates: FoodCandidate[] = [];
  if (plan?.feasible) {
    for (const place of places) {
      // Food kinds only - the new gym/rest_area kinds (P1-9) are
      // workout anchors, never food candidates.
      if (place.kind !== "grocery" && place.kind !== "fast_food") continue;
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
      ...(route.maneuvers ? { maneuvers: route.maneuvers } : {}),
    },
    clocks,
    verdict: {
      status: verdict.status,
      assumedDriveMinutes: Math.round(verdict.assumedDriveMinutes),
      driveTimeBasis: verdict.driveTimeBasis,
      legalLines: verdict.legalLines,
      restedLines: verdict.restedLines,
      lifeLines: verdict.lifeLines,
      paidLines: verdict.paidLines,
      tradeoffLines: verdict.tradeoffLines,
      makeItDepartureAt: verdict.makeItDepartureAt,
      leaveStartByAt: verdict.leaveStartByAt,
    },
    plan: plan
      ? {
          arrivalAt: plan.arrivalAt,
          totalElapsedMinutes: Math.round(plan.totalElapsedMinutes),
          breaks: plan.breaks,
          rests: restsWithPoints,
          workout: plan.workout,
        }
      : null,
    deadhead:
      deadheadRoute && startPoint && verdict.preLeg
        ? {
            startLabel: request.start_location ?? "Your current location",
            startPoint,
            distanceMiles: Math.round(deadheadRoute.distanceMiles * 10) / 10,
            providerDurationMinutes: Math.round(deadheadRoute.durationMinutes),
            provider: deadheadRoute.providerName,
            truckLegal: deadheadRoute.truckLegal,
            geometry: deadheadRoute.geometry,
            leaveByAt: verdict.preLeg.startAt,
            pickupArrivalAt: verdict.preLeg.pickupArrivalAt,
            waitMinutesAtPickup: verdict.preLeg.waitMinutesAtPickup,
            ...(deadheadRoute.maneuvers ? { maneuvers: deadheadRoute.maneuvers } : {}),
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
