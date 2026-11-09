// Expense buckets (owner spec 2026-11-09; docs/design/expense-buckets-documents.md).
// Pure. Every expense is one of two kinds of money:
//  - business: his own company's costs. Lives in the business books,
//    never touches driver pay. The default - a row that doesn't say
//    (including every row recorded before migration 00085) is business.
//  - pay_deduction: a cost the company he drives for takes out of his
//    check (recovery/tow after an incident, damage, chargebacks). It
//    reduces expected pay in the paycheck picture, as its OWN visible
//    line with the reason in words, alongside cash advances - one
//    "what comes out of my check" view, one net:
//    net = expected - advances - deductions, on both ends of the
//    expected range (UNSET miles basis => the net stays a range).
//
// Grouping mirrors cash advances exactly: a deduction belongs to the
// pay week containing its expense_date, under the terms in force on
// that date, and deducts from that week's payday.

import { paydayAfter, weekBounds } from "./pay-projection";
import { termsForDate, type PayTermsRow } from "./paycheck";

export type ExpenseBucket = "business" | "pay_deduction";

export const EXPENSE_BUCKETS: readonly ExpenseBucket[] = ["business", "pay_deduction"];

export const BUCKET_LABELS: Record<ExpenseBucket, string> = {
  business: "Business expense",
  pay_deduction: "Pay deduction — comes out of the check",
};

/** The bucket a row claims; anything else (pre-00085 rows included) is business. */
export function bucketOf(row: { bucket?: string | null }): ExpenseBucket {
  return row.bucket === "pay_deduction" ? "pay_deduction" : "business";
}

export interface DeductionLike {
  amount_cents: number;
  expense_date: string;
  description?: string | null;
  driver_id?: string | null;
}

/** Exact total of a set of pay deductions, in cents. */
export function sumDeductions(deductions: readonly DeductionLike[]): number {
  return deductions.reduce((total, d) => total + d.amount_cents, 0);
}

/** The deductions whose date falls inside a period (inclusive both ends). */
export function deductionsForPeriod<T extends DeductionLike>(deductions: readonly T[], start: string, end: string): T[] {
  return deductions.filter((d) => d.expense_date >= start && d.expense_date <= end);
}

/** The reason a deduction comes out of the check, in words; never blank. */
export function deductionReason(d: { description?: string | null; category?: string | null }): string {
  const words = d.description?.trim();
  if (words) return words;
  return d.category ? `${d.category} chargeback` : "chargeback from the company";
}

export interface DeductionLine {
  amountCents: number;
  date: string;
  reason: string;
}

export interface DeductionWeek {
  start: string;
  end: string;
  /** The payday these deductions come out of; null while the payday weekday is UNSET. */
  payday: string | null;
  totalCents: number;
  lines: DeductionLine[];
}

/** Groups pay deductions by the pay week containing each expense date (newest week first). */
export function groupDeductionsByWeek(
  deductions: readonly (DeductionLike & { category?: string | null })[],
  terms: readonly PayTermsRow[],
): DeductionWeek[] {
  const groups = new Map<string, DeductionWeek>();
  for (const d of deductions) {
    const picked = termsForDate([...terms], d.expense_date)?.terms;
    const bounds = weekBounds(d.expense_date, picked?.pay_week_ends_on);
    const key = bounds.start;
    const g =
      groups.get(key) ??
      {
        start: bounds.start,
        end: bounds.end,
        payday: paydayAfter(bounds.end, picked?.payday_weekday),
        totalCents: 0,
        lines: [],
      };
    g.totalCents += d.amount_cents;
    g.lines.push({ amountCents: d.amount_cents, date: d.expense_date, reason: deductionReason(d) });
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    g.lines.sort((x, y) => y.date.localeCompare(x.date));
  }
  return [...groups.values()].sort((a, b) => b.start.localeCompare(a.start));
}
