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

export interface AutoRunInput {
  loadId?: string | null;
  departAt?: string | null;
  prefs?: AutoPrefs;
  devicePosition?: { lat: number; lng: number; headingDeg?: number | null; speedMph?: number | null } | null;
}

export interface AutoRunResult {
  phase: AutoPhase | "no_load";
  assumptions: string[];
  load: { id: string; label: string; status: string } | null;
  /** Booked loads he can switch to (id + label), newest pickup first. */
  choices: { id: string; label: string }[];
  result: RouteCheckResponse | null;
}

/** The active-load builder routes to the next stop itself; Smart Path routes once, below, so that step is skipped. */
const SKIP_ROUTING: RoutingProvider = {
  getRoute: async () => {
    throw new RoutingUnavailableError("skipped: Smart Path routes the run itself");
  },
} as unknown as RoutingProvider;

const labelOf = (l: Pick<Load, "origin" | "destination" | "trip_number">) => `${l.trip_number ? `Trip ${l.trip_number}: ` : ""}${l.origin} → ${l.destination}`;

export async function runAutoSmartPath(client: SupabaseClient, companyId: string, input: AutoRunInput, now: Date = new Date()): Promise<AutoRunResult> {
  const [state, loadsRes] = await Promise.all([
    buildActiveLoadState(client, companyId, { devicePosition: input.devicePosition ?? null, routing: SKIP_ROUTING, now: () => now }),
    client.from("loads").select("*").eq("company_id", companyId).is("deleted_at", null).in("status", ["confirmed", "draft"]).order("pickup_date", { ascending: false }).limit(30),
  ]);
  const loads = (loadsRes.data ?? []) as Load[];
  const choices = loads.map((l) => ({ id: l.id, label: labelOf(l) }));
  const loadId = input.loadId ?? state.load?.id ?? null;
  if (!loadId) {
    return { phase: "no_load", assumptions: ["No booked load to plan. Add one, or forward the trip to Abel."], load: null, choices, result: null };
  }
  const { data: loadRow, error } = await client.from("loads").select("*").eq("company_id", companyId).eq("id", loadId).is("deleted_at", null).maybeSingle();
  if (error) throw new Error("The load could not be read.");
  if (!loadRow) return { phase: "no_load", assumptions: ["That load could not be found."], load: null, choices, result: null };
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
  });
  const summary = { id: load.id, label: labelOf(load), status: load.status };
  if (!plan.request) return { phase: plan.phase, assumptions: plan.assumptions, load: summary, choices, result: null };
  const result = await runRouteCheck(client, plan.request, undefined, now, companyId);
  return { phase: plan.phase, assumptions: plan.assumptions, load: summary, choices, result };
}
