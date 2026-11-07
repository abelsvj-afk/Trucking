// Cash advances against a payday (owner order 2026-11-07; design
// docs/design/employer-pay-profile.md section 9). Pure.
//  - An advance is money taken OUT of a pay period before payday, recorded
//    when taken (amount always positive; the deduction is what it is).
//  - It belongs to the pay week containing its advance_date, grouped with
//    the pay terms in force on that date - the same rule that groups
//    finished loads into pay weeks - and deducts from that week's payday.
//  - Net = expected - advances, applied to BOTH ends of the expected
//    range: the advances total is exact, and while the miles basis is
//    UNSET the net stays a range, never one confident number.
//  - A net can go negative (more taken out than the week is expected to
//    pay). It is returned as the negative number it is, never clamped.

import { paydayAfter, weekBounds } from "./pay-projection";
import { termsForDate, type PayTermsRow } from "./paycheck";

export interface AdvanceLike {
  amount_cents: number;
  advance_date: string;
  driver_id?: string | null;
}

/** Exact total of a set of advances, in cents. */
export function sumAdvances(advances: readonly AdvanceLike[]): number {
  return advances.reduce((total, a) => total + a.amount_cents, 0);
}

/** The advances whose date falls inside a period (inclusive both ends). */
export function advancesForPeriod<T extends AdvanceLike>(advances: readonly T[], start: string, end: string): T[] {
  return advances.filter((a) => a.advance_date >= start && a.advance_date <= end);
}

/** Expected range minus an exact advances total. */
export function netRange(lowCents: number, highCents: number, advancesCents: number): { lowCents: number; highCents: number } {
  return { lowCents: lowCents - advancesCents, highCents: highCents - advancesCents };
}

export interface AdvanceWeek {
  start: string;
  end: string;
  /** The payday these advances deduct from; null while the payday weekday is UNSET. */
  payday: string | null;
  totalCents: number;
  advances: AdvanceLike[];
}

/** Groups advances by the pay week containing each advance's date (newest week first). */
export function groupAdvancesByWeek(advances: readonly AdvanceLike[], terms: readonly PayTermsRow[]): AdvanceWeek[] {
  const groups = new Map<string, AdvanceWeek>();
  for (const a of advances) {
    const picked = termsForDate([...terms], a.advance_date)?.terms;
    const bounds = weekBounds(a.advance_date, picked?.pay_week_ends_on);
    const key = bounds.start;
    const g =
      groups.get(key) ??
      {
        start: bounds.start,
        end: bounds.end,
        payday: paydayAfter(bounds.end, picked?.payday_weekday),
        totalCents: 0,
        advances: [],
      };
    g.totalCents += a.amount_cents;
    g.advances.push(a);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    g.advances.sort((x, y) => y.advance_date.localeCompare(x.advance_date));
  }
  return [...groups.values()].sort((a, b) => b.start.localeCompare(a.start));
}
