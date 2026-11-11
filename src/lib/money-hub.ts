// Money hub inline totals (UI/UX Phase 4, spec §2.4): the figures
// the hub rows preview so "check" often ends at the hub. Pure — the
// hub feeds it the rows it already fetched; a figure that can't be
// computed honestly comes back null and the row shows NO number
// (never a fake one).

import { addDays, zonedDate } from "@/lib/zoned-day";
import { viewerTimeZone } from "@/lib/time";
import type { PaySummary } from "@/services/api/pay-summary";

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
