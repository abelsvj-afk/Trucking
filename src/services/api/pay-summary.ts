// The server's paycheck picture (owner order 2026-11-05, items 3 and 4).
// One read for Home's card, the Money -> Paychecks page and anything else that
// states expected vs. received pay. Pure builder (unit-tested on fixtures) +
// a thin loader. HOS clocks come from the ONE HOS read (hos-window.ts); there
// is no second HOS implementation here.

import type { SupabaseClient } from "@supabase/supabase-js";
import { pickActiveLoad } from "@/lib/active-load";
import { checkLoad, termsForDate, type PaycheckLine, type PayTermsRow } from "@/lib/paycheck";
import { paydayAfter, weekBounds } from "@/lib/pay-projection";
import { groupAdvancesByWeek, netRange, type AdvanceLike } from "@/lib/cash-advances";
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

/** One pay week of FINISHED loads: what the statement should show and what actually landed. */
export interface PayWeekGroup {
  start: string;
  end: string;
  /** The day the statement comes out / the money lands; null while not set. */
  statement: string | null;
  payday: string | null;
  loadCount: number;
  /** Loads in the week that could not be priced (no mileage / no rate). */
  unpricedCount: number;
  expectedLowCents: number;
  expectedHighCents: number;
  /** Sum of the pay lines settlements name for these loads. */
  receivedCents: number;
  unpaidCount: number;
  shortCount: number;
  shortfallCents: number;
  loadIds: string[];
  /** Cash advances taken out of this week's pay (exact; section 9 of the pay-profile design). */
  advancesCents: number;
  /** Expected minus this week's advances, both ends of the range. Can go negative - shown as-is. */
  netLowCents: number;
  netHighCents: number;
  /** The unpaid loads' slice of the expected range (the Home card nets advances against it). */
  unpaidLowCents: number;
  unpaidHighCents: number;
}

export interface PaySummary {
  /** null when no pay terms exist yet - nothing can be priced. */
  hasTerms: boolean;
  active: (PaySummaryLoad & { overdue: boolean; hosCost: LoadHosCost | null }) | null;
  /** Completed loads, newest delivery first, each checked against what landed. */
  completed: PaySummaryLoad[];
  /** The same finished loads grouped by his pay week (newest first). */
  weeks: PayWeekGroup[];
  totals: {
    unpaidCount: number;
    unpaidLowCents: number;
    unpaidHighCents: number;
    shortCount: number;
    shortfallCents: number;
    /** All advances recorded against the weeks in this summary (exact). */
    advancesCents: number;
    /** Unpaid expected minus the advances taken in those same weeks. */
    unpaidNetLowCents: number;
    unpaidNetHighCents: number;
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

/** Groups the finished loads' checks by pay week; the week boundary and the dates come from the terms in force on each load. */
export function groupByPayWeek(completed: PaySummaryLoad[], terms: PayTermsRow[], loads: Load[]): PayWeekGroup[] {
  const groups = new Map<string, PayWeekGroup>();
  const byId = new Map(loads.map((l) => [l.id, l]));
  for (const c of completed) {
    const load = byId.get(c.loadId);
    const day = c.deliveryDate ?? load?.pickup_date ?? null;
    if (!day) continue;
    const picked = termsForDate(terms, day)?.terms;
    const bounds = weekBounds(day, picked?.pay_week_ends_on);
    const key = `${bounds.start}`;
    const g =
      groups.get(key) ??
      {
        start: bounds.start,
        end: bounds.end,
        statement: paydayAfter(bounds.end, picked?.statement_weekday),
        payday: paydayAfter(bounds.end, picked?.payday_weekday),
        loadCount: 0, unpricedCount: 0, expectedLowCents: 0, expectedHighCents: 0, receivedCents: 0,
        unpaidCount: 0, shortCount: 0, shortfallCents: 0, loadIds: [],
        advancesCents: 0, netLowCents: 0, netHighCents: 0, unpaidLowCents: 0, unpaidHighCents: 0,
      };
    g.loadCount += 1;
    g.loadIds.push(c.loadId);
    const line = c.line;
    if (!line || line.expected.lowCents === null || line.expected.highCents === null) {
      g.unpricedCount += 1;
    } else {
      g.expectedLowCents += line.expected.lowCents;
      g.expectedHighCents += line.expected.highCents;
    }
    g.receivedCents += line?.receivedCents ?? 0;
    if (line?.status === "unpaid") {
      g.unpaidCount += 1;
      g.unpaidLowCents += line.expected.lowCents ?? 0;
      g.unpaidHighCents += line.expected.highCents ?? 0;
    }
    if (line?.status === "short") {
      g.shortCount += 1;
      g.shortfallCents += line.shortfallCents;
    }
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.start.localeCompare(a.start));
}

/**
 * Folds cash advances into the pay weeks (design section 9): each advance
 * lands in the week containing its date - a week with advances but no
 * finished loads still appears, because money was taken against it - and
 * every week's net is its expected range minus its advances.
 */
export function mergeAdvanceWeeks(weeks: PayWeekGroup[], advances: readonly AdvanceLike[], terms: PayTermsRow[]): PayWeekGroup[] {
  if (advances.length === 0) {
    for (const w of weeks) {
      w.netLowCents = w.expectedLowCents;
      w.netHighCents = w.expectedHighCents;
    }
    return weeks;
  }
  const byStart = new Map(weeks.map((w) => [w.start, w]));
  for (const aw of groupAdvancesByWeek(advances, terms)) {
    const existing = byStart.get(aw.start);
    if (existing) {
      existing.advancesCents += aw.totalCents;
      continue;
    }
    const picked = termsForDate(terms, aw.start)?.terms;
    byStart.set(aw.start, {
      start: aw.start,
      end: aw.end,
      statement: paydayAfter(aw.end, picked?.statement_weekday),
      payday: aw.payday,
      loadCount: 0, unpricedCount: 0, expectedLowCents: 0, expectedHighCents: 0, receivedCents: 0,
      unpaidCount: 0, shortCount: 0, shortfallCents: 0, loadIds: [],
      advancesCents: aw.totalCents, netLowCents: 0, netHighCents: 0, unpaidLowCents: 0, unpaidHighCents: 0,
    });
  }
  const merged = [...byStart.values()].sort((a, b) => b.start.localeCompare(a.start));
  for (const w of merged) {
    const net = netRange(w.expectedLowCents, w.expectedHighCents, w.advancesCents);
    w.netLowCents = net.lowCents;
    w.netHighCents = net.highCents;
  }
  return merged;
}

export function buildPaySummary(input: {
  loads: Load[];
  terms: PayTermsRow[];
  /** load id -> sum of its load_pay settlement lines (cents); absent = nothing received. */
  receivedByLoad: Map<string, number>;
  /** Cash advances taken against these pay weeks (design section 9); absent = none recorded. */
  advances?: readonly AdvanceLike[];
  hos: HosGlance | null;
  now: Date;
}): PaySummary {
  const { loads, terms, receivedByLoad, hos, now } = input;
  const advances = input.advances ?? [];
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

  const totals = {
    unpaidCount: 0, unpaidLowCents: 0, unpaidHighCents: 0, shortCount: 0, shortfallCents: 0,
    advancesCents: 0, unpaidNetLowCents: 0, unpaidNetHighCents: 0,
  };
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

  const weeks = mergeAdvanceWeeks(groupByPayWeek(completed, terms, live), advances, terms);
  for (const w of weeks) {
    totals.advancesCents += w.advancesCents;
    if (w.unpaidCount > 0) {
      const net = netRange(w.unpaidLowCents, w.unpaidHighCents, w.advancesCents);
      totals.unpaidNetLowCents += net.lowCents;
      totals.unpaidNetHighCents += net.highCents;
    }
  }
  return { hasTerms: terms.length > 0, active, completed, weeks, totals, hos, asOf: now.toISOString() };
}

export async function loadPaySummary(client: SupabaseClient, companyId: string, now: Date = new Date()): Promise<PaySummary> {
  const [loadsRes, termsRes, linesRes, advancesRes, snapshot] = await Promise.all([
    client.from("loads").select("*").eq("company_id", companyId).is("deleted_at", null).in("status", ["confirmed", "completed"]).order("delivery_date", { ascending: false, nullsFirst: false }).limit(300),
    client.from("employer_pay_profiles").select("employer_name, rate_cents_per_mile, mile_basis, percent_of_load_bps, pay_week_ends_on, statement_weekday, payday_weekday, effective_from, effective_to").eq("company_id", companyId).is("deleted_at", null),
    client.from("settlement_lines").select("load_id, amount_cents").eq("company_id", companyId).eq("kind", "load_pay").not("load_id", "is", null).is("deleted_at", null),
    // Advances degrade to none until migration 00078 is applied - the rest of the paycheck picture must not break first.
    client.from("cash_advances").select("amount_cents, advance_date, driver_id").eq("company_id", companyId).is("deleted_at", null).then((r) => (r.error ? { data: [] as AdvanceLike[] } : r)),
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
    advances: (advancesRes.data ?? []) as AdvanceLike[],
    hos: snapshot ? glanceFromSnapshot(snapshot, now.getTime()) : null,
    now,
  });
}
