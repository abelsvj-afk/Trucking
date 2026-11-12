// THE one source of truth for "the current active load, its next stop, and the route to it" (active-load navigation, points 1-2 and 4).
// The web app (GET /api/v1/active-load) and Abel (the active_load_status tool) both call buildActiveLoadState, so they cannot disagree.
//  - Active load: lib/active-load.ts pickActiveLoad (confirmed loads only), on the Eastern calendar.
//  - Next stop:   lib/next-stop.ts (stop records when they exist, else the load's origin/destination by date, labelled).
//  - Start:       the device's own fix when the caller sends one; otherwise the newest server-known position (Tracker / Telegram).
//                 A position older than MAX_START_AGE_MS is not routed from - the state says how old it is instead.
//  - Route:       the existing provider chain (ORS driving-hgv -> Valhalla truck -> OSRM car) with the truck's own dimensions.
//                 PROVIDER HONESTY: `truckLegal` is the engine's own flag; `guidanceAllowed` is true ONLY for a truck-legal route. A
//                 car-profile route may be shown but is stamped not truck-legal and guidance must refuse to engage on it.
// Nothing is invented: no position, no geocode, or no provider = no route, with the plain reason. Routes are cached in-process for a
// few minutes per (start cell, stop, truck) so Abel and the map asking moments apart get the same answer and one routing call.

import type { SupabaseClient } from "@supabase/supabase-js";
import { pickActiveLoad } from "@/lib/active-load";
import { todayEastern } from "@/lib/eastern-date";
import { checkUTurn } from "@/lib/active-navigation";
import { isTrailering, pickNextStop, type NextStop } from "@/lib/next-stop";
import { deriveTripState, pickupWindowEndMs } from "@/lib/trip-state";
import { haversineMiles, type LatLng } from "@/lib/smart-path";
import { GeocodingUnavailableError, NominatimGeocodingProvider, type GeocodingProvider } from "@/services/integrations/geocoding";
import { defaultRoutingProvider, RoutingUnavailableError, type RouteManeuver, type RoutingProvider, type VehicleProfile } from "@/services/integrations/routing";
import type { Load, LoadStop, Truck } from "@/types/entities";
import { createCachedGeocoder } from "./geocode-cache";

/** A server-known position older than this is not a place to route from. */
export const MAX_START_AGE_MS = 60 * 60_000;
export const ROUTE_CACHE_MS = 5 * 60_000;
/** Start positions are bucketed to about 500 m for the cache. */
const CELL_DEGREES = 0.005;

export interface StartPosition extends LatLng {
  headingDeg: number | null;
  speedMph: number | null;
  /** "device" = sent by the phone asking; "server" = the newest Tracker / Telegram fix. */
  source: "device" | "server";
  recordedAt: string;
  ageSeconds: number;
}

export interface ActiveRouteSummary {
  distanceMiles: number;
  durationMinutes: number;
  /** ISO instant: when the state was built + the drive time. Display it in Eastern time. */
  etaAt: string;
  providerName: string;
  truckLegal: boolean;
  /** Guidance (turn list, live reroute) may engage ONLY on a truck-legal route. */
  guidanceAllowed: boolean;
  /** Set when the route is car-profile only: the words the UI must stamp on it. */
  notTruckLegalNotice: string | null;
  providerNotes: string[];
  geometry: LatLng[];
  maneuvers: RouteManeuver[];
  /** The route needs a reversal (labelled by the engine, or it starts back the way the truck is travelling). */
  needsUTurn: boolean;
  /** needsUTurn AND a trailer is on the load: this route must not be driven or guided on (owner rule). */
  uTurnBlocked: boolean;
}

export interface ActiveLoadState {
  load: {
    id: string;
    origin: string;
    destination: string;
    tripNumber: string | null;
    pickupDate: string | null;
    deliveryDate: string | null;
    overdue: boolean;
    /** The active load has a trailer on it (owner rule 2026-11-10). No U-turns while true. */
    trailering: boolean;
  } | null;
  nextStop: (NextStop & { point: LatLng | null }) | null;
  position: StartPosition | null;
  route: ActiveRouteSummary | null;
  /** Why there is no route, in plain words; null when there is one (or no active load at all). */
  routeUnavailableReason: string | null;
  asOf: string;
}

export const NOT_TRUCK_LEGAL_NOTICE =
  "NOT truck-legal: only a car-profile route could be reached, so it ignores height, weight and truck restrictions. It is shown for reference only - turn-by-turn guidance is off.";

export interface ActiveLoadDeps {
  routing?: RoutingProvider;
  geocoding?: GeocodingProvider;
  now?: () => Date;
  /** The phone's own current fix, when the caller has one. */
  devicePosition?: { lat: number; lng: number; headingDeg?: number | null; speedMph?: number | null } | null;
}

type RouteBase = Omit<ActiveRouteSummary, "etaAt" | "needsUTurn" | "uTurnBlocked">;
interface CachedRoute {
  atMs: number;
  route: RouteBase;
}
const routeCache = new Map<string, CachedRoute>();
/** Test seam. */
export const clearActiveRouteCache = (): void => routeCache.clear();

const cell = (v: number) => Math.round(v / CELL_DEGREES);

async function latestServerPosition(client: SupabaseClient, companyId: string, nowMs: number): Promise<StartPosition | null> {
  const { data, error } = await client
    .from("driver_positions")
    .select("lat, lng, heading_deg, speed_mph, recorded_at")
    .eq("company_id", companyId)
    .order("recorded_at", { ascending: false })
    .limit(1);
  const row = ((data ?? []) as { lat: number; lng: number; heading_deg: number | null; speed_mph: number | null; recorded_at: string }[])[0];
  if (error || !row) return null;
  return {
    lat: row.lat, lng: row.lng, headingDeg: row.heading_deg, speedMph: row.speed_mph, source: "server",
    recordedAt: row.recorded_at, ageSeconds: Math.max(0, Math.round((nowMs - Date.parse(row.recorded_at)) / 1000)),
  };
}

export async function buildActiveLoadState(client: SupabaseClient, companyId: string, deps: ActiveLoadDeps = {}): Promise<ActiveLoadState> {
  const now = (deps.now ?? (() => new Date()))();
  const asOf = now.toISOString();
  const empty: ActiveLoadState = { load: null, nextStop: null, position: null, route: null, routeUnavailableReason: null, asOf };

  const loadsRes = await client.from("loads").select("*").eq("company_id", companyId).eq("status", "confirmed").is("deleted_at", null).limit(200);
  if (loadsRes.error) throw new Error("The active load could not be read.");
  const picked = pickActiveLoad((loadsRes.data ?? []) as Load[], todayEastern(now));
  if (!picked) return empty;
  const load = picked.load;

  const stopsRes = await client.from("load_stops").select("*").eq("company_id", companyId).eq("load_id", load.id).is("deleted_at", null).order("seq", { ascending: true });
  // Stop records are optional (and the table may predate a deployment): an unreadable list falls back to the load's own text.
  const stops = stopsRes.error ? [] : ((stopsRes.data ?? []) as LoadStop[]);

  const position: StartPosition | null = deps.devicePosition
    ? { lat: deps.devicePosition.lat, lng: deps.devicePosition.lng, headingDeg: deps.devicePosition.headingDeg ?? null, speedMph: deps.devicePosition.speedMph ?? null, source: "device", recordedAt: asOf, ageSeconds: 0 }
    : await latestServerPosition(client, companyId, now.getTime());

  // Evidence for the trip-state model (map fix 2026-11-12): how far the truck is from an
  // un-departed pickup, so a trip already picked up stops aiming back at its pickup. The
  // geocoder is cached (migration 00089), so this is one lookup per pickup address ever.
  // Best-effort: a failed lookup leaves the distance unknown and the old behaviour stands.
  const geocoder = createCachedGeocoder(client, companyId, deps.geocoding ?? new NominatimGeocodingProvider(), () => now);
  let pickupDistanceMiles: number | null = null;
  const liveStops = stops.filter((s) => !s.deleted_at).sort((a, b) => a.seq - b.seq);
  const openPickup = liveStops.find((s) => s.kind === "pickup" && !s.departed_at && !s.arrived_at);
  if (position && openPickup) {
    const pickupAddress = (openPickup.address ?? "").trim() || (openPickup.name ?? "").trim();
    if (pickupAddress) {
      try {
        const point = await geocoder.geocode(pickupAddress);
        if (point) pickupDistanceMiles = haversineMiles({ lat: position.lat, lng: position.lng }, point);
      } catch {
        pickupDistanceMiles = null;
      }
    }
  }
  const next = pickNextStop(load, stops, now, todayEastern(now), { pickupDistanceMiles });

  const state: ActiveLoadState = {
    load: {
      id: load.id, origin: load.origin, destination: load.destination, tripNumber: load.trip_number ?? null,
      pickupDate: load.pickup_date, deliveryDate: load.delivery_date, overdue: picked.overdue, trailering: isTrailering(load),
    },
    nextStop: next ? { ...next, point: null } : null,
    position,
    route: null,
    routeUnavailableReason: null,
    asOf,
  };

  if (!next) {
    // No next stop: either every stop is marked left, or the pickup was never marked left
    // and there is no later stop to aim at — in the second case say so plainly.
    const trip = deriveTripState({
      stops: liveStops, now, pickupWindowEndMs: pickupWindowEndMs(load),
      pickupDate: load.pickup_date ? load.pickup_date.slice(0, 10) : null,
      todayIso: todayEastern(now), pickupDistanceMiles,
    });
    state.routeUnavailableReason =
      trip.state === "pickup-unknown" && trip.basis
        ? trip.basis
        : stops.length > 0
          ? "Every stop on this load is marked as left - there is no next stop to route to."
          : "This load has no address to route to.";
    return state;
  }

  // Geocode the stop once (persisted in geocode_cache, migration 00089; the geocoder was
  // created above for the pickup-distance evidence and is reused here).
  let point: LatLng | null;
  try {
    point = await geocoder.geocode(next.address);
  } catch (err) {
    state.routeUnavailableReason = err instanceof GeocodingUnavailableError ? "The address lookup service can't be reached right now, so the stop can't be placed on the map." : "The stop's address couldn't be looked up.";
    return state;
  }
  if (!point) {
    state.routeUnavailableReason = `I couldn't find "${next.address}" on the map. Fix the stop's address and the route appears.`;
    return state;
  }
  state.nextStop = { ...next, point };

  if (!position) {
    state.routeUnavailableReason = "I don't know where the truck is (no Tracker or Telegram position yet, and this device sent none), so there is no route.";
    return state;
  }
  if (position.source === "server" && position.ageSeconds * 1000 > MAX_START_AGE_MS) {
    state.routeUnavailableReason = `The truck's last known position is ${Math.round(position.ageSeconds / 60)} minutes old - too old to route from. Start the Tracker or open the app with location on.`;
    return state;
  }

  let vehicle: VehicleProfile | null = null;
  if (load.truck_id) {
    const truckRes = await client.from("trucks").select("height_in, length_in, weight_lbs").eq("company_id", companyId).eq("id", load.truck_id).is("deleted_at", null).maybeSingle();
    const truck = truckRes.data as Pick<Truck, "height_in" | "length_in" | "weight_lbs"> | null;
    if (truck) vehicle = { heightIn: truck.height_in, lengthIn: truck.length_in, weightLbs: truck.weight_lbs };
  }

  const headingBucket = position.speedMph !== null && position.speedMph >= 8 && position.headingDeg !== null ? Math.round(position.headingDeg / 45) % 8 : "-";
  const key = `${companyId}|${cell(position.lat)},${cell(position.lng)}|${headingBucket}|${point.lat.toFixed(5)},${point.lng.toFixed(5)}|${load.truck_id ?? "-"}`;
  const hit = routeCache.get(key);
  let base: RouteBase;
  if (hit && now.getTime() - hit.atMs < ROUTE_CACHE_MS) {
    base = hit.route;
  } else {
    try {
      // The truck's direction of travel goes to the engine (those that can use it start the route that way instead of reversing).
      const moving = position.speedMph !== null && position.speedMph >= 8 && position.headingDeg !== null;
      const r = await (deps.routing ?? defaultRoutingProvider()).getRoute({ lat: position.lat, lng: position.lng }, point, vehicle, { headingDeg: moving ? position.headingDeg : null });
      base = {
        distanceMiles: Math.round(r.distanceMiles * 10) / 10,
        durationMinutes: Math.round(r.durationMinutes),
        providerName: r.providerName,
        truckLegal: r.truckLegal,
        guidanceAllowed: r.truckLegal,
        notTruckLegalNotice: r.truckLegal ? null : NOT_TRUCK_LEGAL_NOTICE,
        providerNotes: r.providerNotes,
        geometry: r.geometry,
        maneuvers: r.truckLegal ? (r.maneuvers ?? []) : [], // a car route never carries a turn list
      };
      routeCache.set(key, { atMs: now.getTime(), route: base });
    } catch (err) {
      if (!(err instanceof RoutingUnavailableError)) throw err;
      state.routeUnavailableReason = "No routing service could be reached right now, so there is no route. Nothing was guessed.";
      return state;
    }
  }
  // U-turn rule (owner 2026-11-10): no U-turns while the load has a trailer on it. Checked on the RESULT, whatever engine served it.
  // (A car-profile route carries no turn list, so for it only the starts-back-the-way-he-came check applies; it is never guided on anyway.)
  const uTurn = checkUTurn(base, position.headingDeg, position.speedMph);
  state.route = {
    ...base,
    etaAt: new Date(now.getTime() + base.durationMinutes * 60_000).toISOString(),
    needsUTurn: uTurn.needsUTurn,
    uTurnBlocked: uTurn.needsUTurn && state.load!.trailering,
  };
  return state;
}

const etTime = (iso: string) => `${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso))} ET`;

/** The plain-words summary Abel reads (and the web can show): the same facts, one wording. */
export function describeActiveLoadState(s: ActiveLoadState): string {
  if (!s.load) return "No active load: no confirmed load is on the books right now.";
  const lines = [
    `ACTIVE LOAD${s.load.tripNumber ? ` (trip ${s.load.tripNumber})` : ""}: ${s.load.origin} → ${s.load.destination}${s.load.overdue ? " - its delivery date has passed but it is still open" : ""}. ${s.load.trailering ? "Trailer on the load (no U-turns)." : "No trailer on the load (bobtail)."}`,
  ];
  if (s.nextStop) {
    const kind = s.nextStop.kind === "pickup" ? "pickup" : s.nextStop.kind === "delivery" ? "delivery" : "stop";
    lines.push(
      `NEXT STOP: ${kind}${s.nextStop.name ? ` at ${s.nextStop.name}` : ""} - ${s.nextStop.address}${s.nextStop.arrived ? " (marked arrived, not yet left)" : ""}${s.nextStop.appointmentAt ? `; appointment ${etTime(s.nextStop.appointmentAt)}` : ""}.${s.nextStop.basis ? ` ${s.nextStop.basis}` : ""}`,
    );
  } else lines.push("NEXT STOP: none.");
  if (s.route) {
    const hours = Math.floor(s.route.durationMinutes / 60);
    const mins = s.route.durationMinutes % 60;
    lines.push(
      `ROUTE from the truck's ${s.position?.source === "device" ? "current position (this device)" : `last known position (${Math.round((s.position?.ageSeconds ?? 0) / 60)} min old)`}: ${s.route.distanceMiles.toLocaleString("en-US")} miles, about ${hours > 0 ? `${hours} h ` : ""}${mins} min of driving, ETA ${etTime(s.route.etaAt)} if he drives straight through (no breaks counted). Routed by ${s.route.providerName}.`,
    );
    if (!s.route.truckLegal) lines.push(s.route.notTruckLegalNotice ?? NOT_TRUCK_LEGAL_NOTICE);
    if (s.route.uTurnBlocked) lines.push("This route starts with (or contains) a U-turn, which is NOT allowed with a trailer on. Do not tell him to take it - he should keep going and it will route again from further on.");
  } else if (s.routeUnavailableReason) {
    lines.push(`ROUTE: none - ${s.routeUnavailableReason}`);
  }
  return lines.join("\n");
}
