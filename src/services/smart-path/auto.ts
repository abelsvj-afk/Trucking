// Smart Path v2 (docs/design/smart-path-v2.md): plan the run from what the app already knows. Reads the
// active load, its next stop and the truck's position through the same builder Home and Abel use, decides
// the phase (lib/smart-path-auto.ts), then runs the unchanged route-check engine once.

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildActiveLoadState } from "@/services/navigation/active-load-state";
import { RoutingUnavailableError, type RoutingProvider } from "@/services/integrations/routing";
import { runRouteCheck } from "./route-check";
import { planAuto, type AutoPhase, type AutoPrefs } from "@/lib/smart-path-auto";
import type { Load, LoadStop } from "@/types/entities";
import type { RouteCheckResponse } from "@/types/smart-path";
import type { RouteCheckRequest } from "@/data/schemas/smart-path";

export interface AutoRunInput {
  loadId?: string | null;
  departAt?: string | null;
  prefs?: AutoPrefs;
  eldClocks?: RouteCheckRequest["eld_clocks"];
  devicePosition?: { lat: number; lng: number; headingDeg?: number | null; speedMph?: number | null } | null;
}

export interface AutoRunResult {
  phase: AutoPhase | "no_load";
  assumptions: string[];
  load: { id: string; label: string; status: string } | null;
  /** Booked loads he can switch to (id + label), newest pickup first. */
  choices: { id: string; label: string }[];
  result: RouteCheckResponse | null;
  /** Age of the position the plan used, in seconds; null when no position exists at all. */
  positionAgeSeconds: number | null;
  /** True when the routing assumes the pickup is done without a departed_at mark (trip-state model). */
  pickupUnconfirmed: boolean;
  /** The trip-state basis for an unconfirmed pickup, in plain words; null when the pickup is confirmed. */
  pickupUnknownBasis: string | null;
  /** True when the delivery window end was not recorded and appt+2h was used instead. */
  deliveryWindowEstimated: boolean;
}

/** The active-load builder routes to the next stop itself; Smart Path routes once, below, so that step is skipped. */
const SKIP_ROUTING: RoutingProvider = {
  name: "skipped",
  getRoute: async () => {
    throw new RoutingUnavailableError("skipped: Smart Path routes the run itself");
  },
};

const labelOf = (l: Pick<Load, "origin" | "destination" | "trip_number">) => `${l.trip_number ? `Trip ${l.trip_number}: ` : ""}${l.origin} → ${l.destination}`;

export async function runAutoSmartPath(client: SupabaseClient, companyId: string, input: AutoRunInput, now: Date = new Date()): Promise<AutoRunResult> {
  // allSettled, not all: when one read fails, the other's later failure must not become an unhandled rejection.
  const [stateRes, loadsSettled] = await Promise.allSettled([
    buildActiveLoadState(client, companyId, { devicePosition: input.devicePosition ?? null, routing: SKIP_ROUTING, now: () => now }),
    Promise.resolve().then(() =>
      client.from("loads").select("*").eq("company_id", companyId).is("deleted_at", null).in("status", ["confirmed", "draft"]).order("pickup_date", { ascending: false }).limit(30),
    ),
  ]);
  if (stateRes.status === "rejected") throw stateRes.reason;
  const state = stateRes.value;
  const loads = (loadsSettled.status === "fulfilled" ? (loadsSettled.value.data ?? []) : []) as Load[];
  const choices = loads.map((l) => ({ id: l.id, label: labelOf(l) }));
  const loadId = input.loadId ?? state.load?.id ?? null;
  if (!loadId) {
    return { phase: "no_load", assumptions: ["No booked load to plan. Add one, or forward the trip to Abel."], load: null, choices, result: null, positionAgeSeconds: state.position?.ageSeconds ?? null, pickupUnconfirmed: false, pickupUnknownBasis: null, deliveryWindowEstimated: false };
  }
  const { data: loadRow, error } = await client.from("loads").select("*").eq("company_id", companyId).eq("id", loadId).is("deleted_at", null).maybeSingle();
  if (error) throw new Error("The load could not be read.");
  if (!loadRow) return { phase: "no_load", assumptions: ["That load could not be found."], load: null, choices, result: null, positionAgeSeconds: state.position?.ageSeconds ?? null, pickupUnconfirmed: false, pickupUnknownBasis: null, deliveryWindowEstimated: false };
  const load = loadRow as Load;
  const stopsRes = await client.from("load_stops").select("*").eq("company_id", companyId).eq("load_id", load.id).is("deleted_at", null).order("seq", { ascending: true });
  const stops = stopsRes.error ? [] : ((stopsRes.data ?? []) as LoadStop[]);
  const isActive = state.load?.id === load.id;
  const plan = planAuto({
    load,
    stops,
    nextStopKind: isActive ? (state.nextStop?.kind ?? null) : null,
    position: state.position ? { lat: state.position.lat, lng: state.position.lng, ageSeconds: state.position.ageSeconds, source: state.position.source } : null,
    now,
    departAt: input.departAt ?? null,
    prefs: input.prefs,
    eldClocks: input.eldClocks,
  });
  const summary = { id: load.id, label: labelOf(load), status: load.status };
  // The trip-state basis rides along for the watch: when the pickup was never marked left, the alert's
  // "why" must say so instead of silently routing via the pickup (or past it).
  const pickupUnconfirmed = isActive ? (state.nextStop?.pickupUnconfirmed ?? false) : false;
  const pickupUnknownBasis = pickupUnconfirmed ? (state.nextStop?.basis ?? null) : null;
  if (!plan.request) return { phase: plan.phase, assumptions: plan.assumptions, load: summary, choices, result: null, positionAgeSeconds: plan.positionAgeSeconds, pickupUnconfirmed, pickupUnknownBasis, deliveryWindowEstimated: plan.deliveryWindowEstimated };
  const result = await runRouteCheck(client, plan.request, undefined, now, companyId);
  return { phase: plan.phase, assumptions: plan.assumptions, load: summary, choices, result, positionAgeSeconds: plan.positionAgeSeconds, pickupUnconfirmed, pickupUnknownBasis, deliveryWindowEstimated: plan.deliveryWindowEstimated };
}
