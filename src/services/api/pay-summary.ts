// The server's paycheck picture (owner order 2026-11-05, items 3 and 4).
// One read for Home's card, the Money -> Paychecks page and anything else that
// states expected vs. received pay. Pure builder (unit-tested on fixtures) +
// a thin loader. HOS clocks come from the ONE HOS read (hos-window.ts); there
// is no second HOS implementation here.

import type { SupabaseClient } from "@supabase/supabase-js";
import { pickActiveLoad } from "@/lib/active-load";
import { checkLoad, type PaycheckLine, type PayTermsRow } from "@/lib/paycheck";
import { computeHudClocks } from "@/lib/hud-clocks";
import { loadHosCost, type HosGlance, type LoadHosCost } from "@/lib/hos-cost";
import { todayEastern } from "@/lib/eastern-date";
import { loadHosWindow, toWindowSummary, type HosWindowSnapshot } from "@/services/api/hos-window";
import type { Load } from "@/types/entities";

export interface PaySummaryLoad {
  loadId: string;
  origin: string;
  destination: string;
  tripNumber: string | null;
  status: Load["status"];
  deliveryDate: string | null;
  line: PaycheckLine | null;
}

export interface PaySummary {
  /** null when no pay terms exist yet - nothing can be priced. */
  hasTerms: boolean;
  active: (PaySummaryLoad & { overdue: boolean; hosCost: LoadHosCost | null }) | null;
  /** Completed loads, newest delivery first, each checked against what landed. */
  completed: PaySummaryLoad[];
  totals: {
    unpaidCount: number;
    unpaidLowCents: number;
    unpaidHighCents: number;
    shortCount: number;
    shortfallCents: number;
  };
  hos: (HosGlance & { breakDueInMs: number }) | null;
  asOf: string;
}

export function glanceFromSnapshot(snapshot: HosWindowSnapshot, nowMs: number): HosGlance | null {
  const result = computeHudClocks(snapshot.rows, toWindowSummary(snapshot), nowMs);
  if (result.state !== "ready") return null;
  const left = (key: string) => result.clocks.find((c) => c.key === key)?.remainingMs ?? null;
  const cycle = result.clocks.find((c) => c.key === "cycle");
  return {
    driveLeftMs: left("drive") ?? 0,
    windowLeftMs: left("window") ?? 0,
    breakDueInMs: left("break") ?? 0,
    cycleLeftMs: cycle ? cycle.remainingMs : null,
    cycleLabel: cycle ? cycle.label : null,
    rested: result.rested,
  };
}

/** Miles he will actually drive: loaded + deadhead when both are known, else the load total. */
function driveMiles(l: Load): number | null {
  if (l.loaded_miles != null && l.deadhead_miles != null) return l.loaded_miles + l.deadhead_miles;
  return l.miles ?? l.loaded_miles ?? null;
}

export function buildPaySummary(input: {
  loads: Load[];
  terms: PayTermsRow[];
  /** load id -> sum of its load_pay settlement lines (cents); absent = nothing received. */
  receivedByLoad: Map<string, number>;
  hos: HosGlance | null;
  now: Date;
}): PaySummary {
  const { loads, terms, receivedByLoad, hos, now } = input;
  const row = (l: Load): PaySummaryLoad => ({
    loadId: l.id,
    origin: l.origin,
    destination: l.destination,
    tripNumber: l.trip_number ?? null,
    status: l.status,
    deliveryDate: l.delivery_date,
    line: checkLoad(l, terms, receivedByLoad.get(l.id) ?? null),
  });

  const live = loads.filter((l) => !l.deleted_at);
  const completed = live
    .filter((l) => l.status === "completed")
    .sort((a, b) => (b.delivery_date ?? "").localeCompare(a.delivery_date ?? ""))
    .map(row);

  const picked = pickActiveLoad(live, todayEastern(now));
  const active = picked
    ? {
        ...row(picked.load),
        overdue: picked.overdue,
        hosCost: loadHosCost(driveMiles(picked.load), hos),
      }
    : null;

  const totals = { unpaidCount: 0, unpaidLowCents: 0, unpaidHighCents: 0, shortCount: 0, shortfallCents: 0 };
  for (const c of completed) {
    const line = c.line;
    if (!line) continue;
    if (line.status === "unpaid") {
      totals.unpaidCount += 1;
      totals.unpaidLowCents += line.expected.lowCents ?? 0;
      totals.unpaidHighCents += line.expected.highCents ?? 0;
    } else if (line.status === "short") {
      totals.shortCount += 1;
      totals.shortfallCents += line.shortfallCents;
    }
  }

  return { hasTerms: terms.length > 0, active, completed, totals, hos, asOf: now.toISOString() };
}

export async function loadPaySummary(client: SupabaseClient, companyId: string, now: Date = new Date()): Promise<PaySummary> {
  const [loadsRes, termsRes, linesRes, snapshot] = await Promise.all([
    client.from("loads").select("*").eq("company_id", companyId).is("deleted_at", null).in("status", ["confirmed", "completed"]).order("delivery_date", { ascending: false, nullsFirst: false }).limit(300),
    client.from("employer_pay_profiles").select("employer_name, rate_cents_per_mile, mile_basis, percent_of_load_bps, pay_week_ends_on, payday_weekday, effective_from, effective_to").eq("company_id", companyId).is("deleted_at", null),
    client.from("settlement_lines").select("load_id, amount_cents").eq("company_id", companyId).eq("kind", "load_pay").not("load_id", "is", null).is("deleted_at", null),
    loadHosWindow(client, companyId, now).catch(() => null),
  ]);
  if (loadsRes.error || termsRes.error || linesRes.error) throw new Error("The paycheck picture could not be loaded.");
  const receivedByLoad = new Map<string, number>();
  for (const l of (linesRes.data ?? []) as { load_id: string; amount_cents: number }[]) {
    receivedByLoad.set(l.load_id, (receivedByLoad.get(l.load_id) ?? 0) + l.amount_cents);
  }
  return buildPaySummary({
    loads: (loadsRes.data ?? []) as Load[],
    terms: (termsRes.data ?? []) as PayTermsRow[],
    receivedByLoad,
    hos: snapshot ? glanceFromSnapshot(snapshot, now.getTime()) : null,
    now,
  });
}
