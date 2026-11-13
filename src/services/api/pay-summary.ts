// The server's paycheck picture (owner order 2026-11-05, items 3 and 4).
// One read for Home's card, the Money -> Paychecks page and anything else that
// states expected vs. received pay. Pure builder (unit-tested on fixtures) +
// a thin loader. HOS clocks come from the ONE HOS read (hos-window.ts); there
// is no second HOS implementation here.

import type { SupabaseClient } from "@supabase/supabase-js";
import { pickActiveLoad } from "@/lib/active-load";
import { checkLoad, termsForDate, type PaycheckLine, type PayTermsRow } from "@/lib/paycheck";
import { COUNTED_STATUSES, paydayAfter, weekBounds } from "@/lib/pay-projection";
import { groupAdvancesByWeek, netRange, type AdvanceLike } from "@/lib/cash-advances";
import { groupDeductionsByWeek, type DeductionLike, type DeductionLine } from "@/lib/expense-buckets";
import { computeHudClocks } from "@/lib/hud-clocks";
import { taxSetAsideFor, type TaxSetAside } from "@/lib/tax-set-aside";
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
  /** Pay-deduction expenses taken out of this week's pay (exact; expense buckets spec 2026-11-09). */
  deductionsCents: number;
  /** Each deduction in this week, with its reason in words - the visible lines behind deductionsCents. */
  deductionLines: DeductionLine[];
  /** Expected minus this week's advances AND pay deductions, both ends of the range. Can go negative - shown as-is. */
  netLowCents: number;
  netHighCents: number;
  /** The unpaid loads' slice of the expected range (the Home card nets advances against it). */
  unpaidLowCents: number;
  unpaidHighCents: number;
}

/**
 * One PAYDAY: the pay weeks that land on the same payday, with the money plainly separated (owner order 2026-11-06/07).
 *   expected     what the finished loads should pay at the terms in force (a range while the miles basis is unset)
 *   advances     cash advances already taken out of those weeks (exact)
 *   net          expected - advances (can go negative; never clamped)
 *   received     the pay lines statements have named for these loads so far
 *   stillOwed    net - received. Negative means nothing more is owed (a statement already covered it); the page says so in words.
 * The per-load rows stay underneath (`loads`), not instead of this.
 */
export interface PaydayGroup {
  /** The day the money lands; null while the pay terms don't say. */
  payday: string | null;
  statement: string | null;
  periodStart: string;
  periodEnd: string;
  weekStarts: string[];
  loadCount: number;
  unpricedCount: number;
  expectedLowCents: number;
  expectedHighCents: number;
  advancesCents: number;
  deductionsCents: number;
  deductionLines: DeductionLine[];
  netLowCents: number;
  netHighCents: number;
  receivedCents: number;
  stillOwedLowCents: number;
  stillOwedHighCents: number;
  shortCount: number;
  shortfallCents: number;
  unpaidCount: number;
  /** Payday has passed (Eastern) and money is still owed - worth a look. */
  overdue: boolean;
  loads: PaySummaryLoad[];
  /**
   * Tax set-aside recommendation for this paycheck (migration 00094):
   * the % of the expected gross a 1099 contractor should set aside.
   * Null when the terms in force are not a 1099 contractor (W2, or
   * worker_type still UNSET) - then no line shows. Display only; it
   * never moves money and is never subtracted from the net.
   */
  taxSetAside: (TaxSetAside & { grossLowCents: number; grossHighCents: number }) | null;
}

export interface PaySummary {
  /** null when no pay terms exist yet - nothing can be priced. */
  hasTerms: boolean;
  active: (PaySummaryLoad & { overdue: boolean; hosCost: LoadHosCost | null }) | null;
  /** Completed loads, newest delivery first, each checked against what landed. */
  completed: PaySummaryLoad[];
  /** The same finished loads grouped by his pay week (newest first). */
  weeks: PayWeekGroup[];
  /** The pay weeks regrouped by PAYDAY (newest first) with per-load detail - the one builder the Paychecks page and Abel both read. */
  paydays: PaydayGroup[];
  totals: {
    unpaidCount: number;
    unpaidLowCents: number;
    unpaidHighCents: number;
    shortCount: number;
    shortfallCents: number;
    /** All advances recorded against the weeks in this summary (exact). */
    advancesCents: number;
    /** All pay deductions recorded against the weeks in this summary (exact). */
    deductionsCents: number;
    /** Unpaid expected minus the advances and pay deductions taken in those same weeks. */
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
        advancesCents: 0, deductionsCents: 0, deductionLines: [], netLowCents: 0, netHighCents: 0, unpaidLowCents: 0, unpaidHighCents: 0,
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
    // A booked (confirmed, not delivered) load is EXPECTED pay but is not "unpaid" or "short" yet - those need a finished load.
    const finished = c.status === "completed";
    if (finished && line?.status === "unpaid") {
      g.unpaidCount += 1;
      g.unpaidLowCents += line.expected.lowCents ?? 0;
      g.unpaidHighCents += line.expected.highCents ?? 0;
    }
    if (finished && line?.status === "short") {
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
      advancesCents: aw.totalCents, deductionsCents: 0, deductionLines: [], netLowCents: 0, netHighCents: 0, unpaidLowCents: 0, unpaidHighCents: 0,
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

/**
 * Folds pay-deduction expenses (expense buckets spec 2026-11-09) into
 * the pay weeks, exactly like advances: each deduction lands in the
 * week containing its expense_date, under the terms in force on that
 * date - a week with deductions but no finished loads still appears,
 * because money comes out of that week's check - and every week's net
 * is recomputed over advances AND deductions together, on both ends of
 * the range, never clamped (a net can go negative and is shown as-is).
 */
export function mergeDeductionWeeks(
  weeks: PayWeekGroup[],
  deductions: readonly (DeductionLike & { category?: string | null })[],
  terms: PayTermsRow[],
): PayWeekGroup[] {
  if (deductions.length === 0) return weeks;
  const byStart = new Map(weeks.map((w) => [w.start, w]));
  for (const dw of groupDeductionsByWeek(deductions, terms)) {
    const existing = byStart.get(dw.start);
    if (existing) {
      existing.deductionsCents += dw.totalCents;
      existing.deductionLines = [...existing.deductionLines, ...dw.lines].sort((a, b) => b.date.localeCompare(a.date));
      continue;
    }
    const picked = termsForDate(terms, dw.start)?.terms;
    byStart.set(dw.start, {
      start: dw.start,
      end: dw.end,
      statement: paydayAfter(dw.end, picked?.statement_weekday),
      payday: dw.payday,
      loadCount: 0, unpricedCount: 0, expectedLowCents: 0, expectedHighCents: 0, receivedCents: 0,
      unpaidCount: 0, shortCount: 0, shortfallCents: 0, loadIds: [],
      advancesCents: 0, deductionsCents: dw.totalCents, deductionLines: dw.lines,
      netLowCents: 0, netHighCents: 0, unpaidLowCents: 0, unpaidHighCents: 0,
    });
  }
  const merged = [...byStart.values()].sort((a, b) => b.start.localeCompare(a.start));
  for (const w of merged) {
    const net = netRange(w.expectedLowCents, w.expectedHighCents, w.advancesCents + w.deductionsCents);
    w.netLowCents = net.lowCents;
    w.netHighCents = net.highCents;
  }
  return merged;
}

/** Regroups pay weeks by the payday they land on. Pure; the per-load rows come from the same `completed` list the page already shows. The optional `terms` let each payday carry its tax set-aside (migration 00094): the terms in force on the group's first week decide the worker type and percent - a terms change mid-payday keeps the opening terms for the recommendation, and the % shown is the one applied. */
export function groupByPayday(weeks: PayWeekGroup[], completed: PaySummaryLoad[], today: string, terms?: PayTermsRow[]): PaydayGroup[] {
  const byId = new Map(completed.map((c) => [c.loadId, c]));
  const groups = new Map<string, PaydayGroup>();
  for (const w of weeks) {
    const key = w.payday ?? `week:${w.start}`;
    const g =
      groups.get(key) ??
      {
        payday: w.payday, statement: w.statement, periodStart: w.start, periodEnd: w.end, weekStarts: [],
        loadCount: 0, unpricedCount: 0, expectedLowCents: 0, expectedHighCents: 0, advancesCents: 0, netLowCents: 0, netHighCents: 0,
        receivedCents: 0, stillOwedLowCents: 0, stillOwedHighCents: 0, shortCount: 0, shortfallCents: 0, unpaidCount: 0, overdue: false, loads: [],
        deductionsCents: 0, deductionLines: [], taxSetAside: null,
      };
    g.weekStarts.push(w.start);
    if (w.start < g.periodStart) g.periodStart = w.start;
    if (w.end > g.periodEnd) g.periodEnd = w.end;
    g.loadCount += w.loadCount;
    g.unpricedCount += w.unpricedCount;
    g.expectedLowCents += w.expectedLowCents;
    g.expectedHighCents += w.expectedHighCents;
    g.advancesCents += w.advancesCents;
    g.deductionsCents += w.deductionsCents;
    g.deductionLines.push(...w.deductionLines);
    g.netLowCents += w.netLowCents;
    g.netHighCents += w.netHighCents;
    g.receivedCents += w.receivedCents;
    g.shortCount += w.shortCount;
    g.shortfallCents += w.shortfallCents;
    g.unpaidCount += w.unpaidCount;
    for (const id of w.loadIds) {
      const row = byId.get(id);
      if (row) g.loads.push(row);
    }
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    g.stillOwedLowCents = g.netLowCents - g.receivedCents;
    g.stillOwedHighCents = g.netHighCents - g.receivedCents;
    g.overdue = g.payday !== null && g.payday < today && g.stillOwedHighCents > 0;
    g.loads.sort((a, b) => (b.deliveryDate ?? "").localeCompare(a.deliveryDate ?? ""));
    if (terms) {
      const picked = termsForDate(terms, g.periodStart)?.terms;
      const setAside = picked
        ? taxSetAsideFor(g.expectedLowCents, g.expectedHighCents, picked.worker_type ?? null, picked.tax_set_aside_bps ?? null)
        : null;
      g.taxSetAside = setAside ? { ...setAside, grossLowCents: g.expectedLowCents, grossHighCents: g.expectedHighCents } : null;
    }
  }
  return [...groups.values()].sort((a, b) => (b.payday ?? b.periodStart).localeCompare(a.payday ?? a.periodStart));
}

export function buildPaySummary(input: {
  loads: Load[];
  terms: PayTermsRow[];
  /** load id -> sum of its load_pay settlement lines (cents); absent = nothing received. */
  receivedByLoad: Map<string, number>;
  /** Cash advances taken against these pay weeks (design section 9); absent = none recorded. */
  advances?: readonly AdvanceLike[];
  /** Pay-deduction expenses taken against these pay weeks (expense buckets spec); absent = none recorded. */
  deductions?: readonly (DeductionLike & { category?: string | null })[];
  hos: HosGlance | null;
  now: Date;
}): PaySummary {
  const { loads, terms, receivedByLoad, hos, now } = input;
  const advances = input.advances ?? [];
  const deductions = input.deductions ?? [];
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
    advancesCents: 0, deductionsCents: 0, unpaidNetLowCents: 0, unpaidNetHighCents: 0,
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

  // The pay weeks and paydays use the SAME loads Projected Pay counts (booked + finished, COUNTED_STATUSES), priced by the same
  // projection, so "expected - advances" is one number on both pages. Booked-not-delivered loads are expected pay but never
  // flagged unpaid/short; the flat `completed` list above stays finished-only.
  const counted = live
    .filter((l) => COUNTED_STATUSES.has(l.status))
    .sort((a, b) => (b.delivery_date ?? "").localeCompare(a.delivery_date ?? ""))
    .map(row);
  const weeks = mergeDeductionWeeks(mergeAdvanceWeeks(groupByPayWeek(counted, terms, live), advances, terms), deductions, terms);
  for (const w of weeks) {
    totals.advancesCents += w.advancesCents;
    totals.deductionsCents += w.deductionsCents;
    if (w.unpaidCount > 0) {
      const net = netRange(w.unpaidLowCents, w.unpaidHighCents, w.advancesCents + w.deductionsCents);
      totals.unpaidNetLowCents += net.lowCents;
      totals.unpaidNetHighCents += net.highCents;
    }
  }
  const paydays = groupByPayday(weeks, counted, todayEastern(now), terms);
  return { hasTerms: terms.length > 0, active, completed, weeks, paydays, totals, hos, asOf: now.toISOString() };
}

/**
 * The pay-deduction expenses for the paycheck picture. A read error is
 * NOT swallowed - expected pay with deductions silently zeroed would
 * present as final while an input failed - with ONE exception: before
 * migration 00085 is applied the bucket column does not exist, and
 * there no deduction CAN exist, so that one error degrades to "none
 * recorded" and the rest of the picture works.
 */
async function loadPayDeductions(
  client: SupabaseClient,
  companyId: string,
): Promise<(DeductionLike & { category?: string | null })[]> {
  const withBucket = await client
    .from("expenses")
    .select("amount_cents, expense_date, description, category, driver_id, bucket")
    .eq("company_id", companyId)
    .eq("bucket", "pay_deduction")
    .is("deleted_at", null);
  if (!withBucket.error) return (withBucket.data ?? []) as (DeductionLike & { category?: string | null })[];
  if (/bucket/i.test(withBucket.error.message)) return [];
  throw new Error("The paycheck picture could not be loaded.");
}

export async function loadPaySummary(client: SupabaseClient, companyId: string, now: Date = new Date()): Promise<PaySummary> {
  const [loadsRes, termsRes, linesRes, advancesRes, deductions, snapshot] = await Promise.all([
    client.from("loads").select("*").eq("company_id", companyId).is("deleted_at", null).in("status", ["confirmed", "completed"]).order("delivery_date", { ascending: false, nullsFirst: false }).limit(300),
    client.from("employer_pay_profiles").select("employer_name, rate_cents_per_mile, mile_basis, worker_type, tax_set_aside_bps, percent_of_load_bps, pay_week_ends_on, statement_weekday, payday_weekday, effective_from, effective_to").eq("company_id", companyId).is("deleted_at", null),
    client.from("settlement_lines").select("load_id, amount_cents").eq("company_id", companyId).eq("kind", "load_pay").not("load_id", "is", null).is("deleted_at", null),
    // An advances error is NOT swallowed: expected pay with zero advances deducted would present as final while part of its inputs
    // failed to load. It fails visibly like loads, terms and settlement lines (00079 is applied; the old bridge's reason is gone).
    client.from("cash_advances").select("amount_cents, advance_date, driver_id").eq("company_id", companyId).is("deleted_at", null),
    loadPayDeductions(client, companyId),
    loadHosWindow(client, companyId, now).catch(() => null),
  ]);
  if (loadsRes.error || termsRes.error || linesRes.error || advancesRes.error) throw new Error("The paycheck picture could not be loaded.");
  const receivedByLoad = new Map<string, number>();
  for (const l of (linesRes.data ?? []) as { load_id: string; amount_cents: number }[]) {
    receivedByLoad.set(l.load_id, (receivedByLoad.get(l.load_id) ?? 0) + l.amount_cents);
  }
  return buildPaySummary({
    loads: (loadsRes.data ?? []) as Load[],
    terms: (termsRes.data ?? []) as PayTermsRow[],
    receivedByLoad,
    advances: (advancesRes.data ?? []) as AdvanceLike[],
    deductions,
    hos: snapshot ? glanceFromSnapshot(snapshot, now.getTime()) : null,
    now,
  });
}
