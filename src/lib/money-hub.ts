// Money hub inline totals (UI/UX Phase 4, spec §2.4): the figures
// the hub rows preview so "check" often ends at the hub. Pure — the
// hub feeds it the rows it already fetched; a figure that can't be
// computed honestly comes back null and the row shows NO number
// (never a fake one).

import { addDays, zonedDate } from "@/lib/zoned-day";
import { viewerTimeZone } from "@/lib/time";
import type { PaySummary, PaydayGroup } from "@/services/api/pay-summary";
import { advancesForPeriod, netRange, sumAdvances } from "@/lib/cash-advances";
import { deductionsForPeriod, sumDeductions } from "@/lib/expense-buckets";
import { formatMoney } from "@/lib/money-format";
import type { PayProjectionState } from "@/lib/use-pay-projection";

/** Sun–Sat week bounds (YYYY-MM-DD) containing `date` — the hub's week convention. */
export function sunSatWeekBounds(date: string): { start: string; end: string } {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const start = addDays(date, -dow);
  return { start, end: addDays(start, 6) };
}

/** Total of expenses dated inside the current Sun–Sat week (viewer's zone). */
export function thisWeekExpensesCents(
  expenses: { amount_cents: number; expense_date: string }[],
  nowMs: number = Date.now(),
): number {
  const today = zonedDate(nowMs, viewerTimeZone());
  const { start, end } = sunSatWeekBounds(today);
  return expenses
    .filter((e) => e.expense_date >= start && e.expense_date <= end)
    .reduce((sum, e) => sum + e.amount_cents, 0);
}

/**
 * The last DEFINITE paycheck figure from the pay summary: the most
 * recent payday group whose expected range has collapsed to one
 * number (low === high) — a range is not definite, so it is skipped,
 * and when no group is definite the hub shows nothing.
 */
export function lastDefinitePaycheckCents(summary: PaySummary): number | null {
  const definite = summary.paydays.filter(
    (g) => g.expectedLowCents === g.expectedHighCents && g.loadCount > 0,
  );
  if (definite.length === 0) return null;
  const sorted = [...definite].sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  return sorted[0]!.expectedLowCents;
}

// --- This pay week's net (docs/design/money-hub-net-first.md, owner-approved 2026-11-12) -------------------
// ONE calculation for "what this pay week nets", read by Home's pay card and by Money's top block, so the two
// can never disagree. It is the calculation Home's card already did inline, moved here unchanged:
// this week's projection, minus the advances and pay deductions dated inside this week.

type ReadyProjection = Extract<PayProjectionState, { status: "ready" }>;

export interface PayWeekNet {
  advancesCents: number;
  deductionsCents: number;
  /** advances + deductions. */
  outCents: number;
  /**
   * Expected pay minus what is already coming out. null when the advances or the deductions read FAILED:
   * a net with a missing input is never shown (pay truth fail-safe, 2026-11-07).
   */
  net: { lowCents: number; highCents: number } | null;
  advancesUnavailable: boolean;
  deductionsUnavailable: boolean;
  outUnavailable: boolean;
  /** This pay week has a booked load or something taken out of it. */
  hasWeek: boolean;
}

export function payWeekNet(projection: ReadyProjection): PayWeekNet {
  const { period } = projection;
  const advancesUnavailable = projection.advancesAvailable === false;
  const deductionsUnavailable = projection.deductionsAvailable === false;
  const outUnavailable = advancesUnavailable || deductionsUnavailable;
  const advancesCents = outUnavailable ? 0 : sumAdvances(advancesForPeriod(projection.advances, period.start, period.end));
  const deductionsCents = outUnavailable ? 0 : sumDeductions(deductionsForPeriod(projection.deductions, period.start, period.end));
  const outCents = advancesCents + deductionsCents;
  return {
    advancesCents,
    deductionsCents,
    outCents,
    net: outUnavailable ? null : netRange(period.lowCents, period.highCents, outCents),
    advancesUnavailable,
    deductionsUnavailable,
    outUnavailable,
    hasWeek: period.rows.length > 0 || outCents > 0,
  };
}

/** One figure when the range has collapsed; otherwise the range, in words. A range is never squeezed into one number. */
export function formatMoneyRange(lowCents: number, highCents: number): string {
  return lowCents === highCents ? formatMoney(lowCents) : `about ${formatMoney(lowCents)} to ${formatMoney(highCents)}`;
}

export type PayWeekStatus = "paid" | "short" | "unpaid";

export interface RecentPayWeek {
  key: string;
  periodStart: string;
  periodEnd: string;
  payday: string | null;
  expectedLowCents: number;
  expectedHighCents: number;
  receivedCents: number;
  loadCount: number;
  /** Expected is what the loads should pay; this says what has actually happened to it. */
  status: PayWeekStatus;
  /** 0..1, the bar length against the largest expected amount shown. */
  share: number;
}

function statusOf(g: PaydayGroup): PayWeekStatus {
  if (g.shortCount > 0) return "short";
  if (g.unpaidCount > 0 || g.stillOwedHighCents > 0) return "unpaid";
  return "paid";
}

/**
 * Up to `limit` finished pay weeks, newest first, for the Money hub. Weeks with no finished load are left out
 * (an empty bar would read as a week that paid nothing). `beforeDay` drops the week still in progress, which
 * the top block already shows from the projection.
 */
export function recentPayWeeks(summary: PaySummary, beforeDay: string | null, limit = 6): RecentPayWeek[] {
  const groups = summary.paydays
    .filter((g) => g.loadCount > 0 && (beforeDay === null || g.periodEnd < beforeDay))
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))
    .slice(0, limit);
  const largest = Math.max(1, ...groups.map((g) => g.expectedHighCents));
  return groups.map((g) => ({
    key: g.payday ?? `week:${g.periodStart}`,
    periodStart: g.periodStart,
    periodEnd: g.periodEnd,
    payday: g.payday,
    expectedLowCents: g.expectedLowCents,
    expectedHighCents: g.expectedHighCents,
    receivedCents: g.receivedCents,
    loadCount: g.loadCount,
    status: statusOf(g),
    share: Math.max(0, Math.min(1, g.expectedHighCents / largest)),
  }));
}
