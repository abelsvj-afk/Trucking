// Expected pay vs. what actually landed (owner order 2026-11-05, item 3). Pure.
//  - A load is priced with the pay-terms row IN FORCE ON ITS DELIVERY DATE
//    (terms are dated rows, so a rate change never rewrites old loads);
//    a load with no delivery date uses its pickup date; if no row covers that
//    date the nearest row is used and the result says so.
//  - "Received" is the sum of the settlement lines of kind load_pay that name
//    the load (the 00048 model: the driver's pay line per load).
//  - A load is SHORT when received falls below the LOW end of the expected
//    range by more than the tolerance (carriers round miles differently); it is
//    UNPAID when no pay line names it at all. Nothing is flagged on a load whose
//    expected pay cannot be computed.
// Gross at his stated rate; his settlement is the final number.

import { projectLoad, type LoadProjection, type PayTerms, type ProjectableLoad } from "./pay-projection";

export interface PayTermsRow extends PayTerms {
  effective_from: string;
  effective_to: string | null;
}

/** Short only beyond this: the larger of $5 or 1% of the expected low end. */
export const SHORT_TOLERANCE_MIN_CENTS = 500;
export const SHORT_TOLERANCE_PCT = 0.01;

export function termsForDate(rows: PayTermsRow[], date: string | null): { terms: PayTermsRow; inForce: boolean } | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  if (date) {
    const covering = sorted.filter((r) => r.effective_from <= date && (r.effective_to === null || r.effective_to >= date));
    // Latest-starting row that covers the date (rows should not overlap; if they do, the newer wins).
    if (covering.length > 0) return { terms: covering[covering.length - 1]!, inForce: true };
    // Before the first row: the earliest. After the last closed row: the latest.
    const before = sorted.filter((r) => r.effective_from > date);
    if (before.length === sorted.length) return { terms: sorted[0]!, inForce: false };
  }
  return { terms: sorted[sorted.length - 1]!, inForce: false };
}

export type PaycheckStatus = "paid" | "short" | "over" | "unpaid" | "unknown";

export interface PaycheckLine {
  loadId: string;
  expected: LoadProjection;
  /** Which terms priced it, and whether a row actually covered the date. */
  termsUsed: {
    employer_name: string;
    rate_cents_per_mile: number;
    mile_basis: PayTerms["mile_basis"];
    worker_type: PayTerms["worker_type"];
    tax_set_aside_bps: PayTerms["tax_set_aside_bps"];
    inForce: boolean;
  };
  receivedCents: number | null;
  status: PaycheckStatus;
  /** Cents below the expected LOW end when short; 0 otherwise. */
  shortfallCents: number;
}

export function checkLoad(load: ProjectableLoad, rows: PayTermsRow[], receivedCents: number | null): PaycheckLine | null {
  const picked = termsForDate(rows, load.delivery_date ?? load.pickup_date);
  if (!picked) return null;
  const expected = projectLoad(picked.terms, load);
  const termsUsed = {
    employer_name: picked.terms.employer_name,
    rate_cents_per_mile: picked.terms.rate_cents_per_mile,
    mile_basis: picked.terms.mile_basis,
    worker_type: picked.terms.worker_type ?? null,
    tax_set_aside_bps: picked.terms.tax_set_aside_bps ?? null,
    inForce: picked.inForce,
  };
  const base = { loadId: load.id, expected, termsUsed, receivedCents };
  if (expected.lowCents === null || expected.highCents === null) return { ...base, status: "unknown", shortfallCents: 0 };
  if (receivedCents === null) return { ...base, status: "unpaid", shortfallCents: 0 };
  const tolerance = Math.max(SHORT_TOLERANCE_MIN_CENTS, Math.round(expected.lowCents * SHORT_TOLERANCE_PCT));
  if (receivedCents < expected.lowCents - tolerance) {
    return { ...base, status: "short", shortfallCents: expected.lowCents - receivedCents };
  }
  if (receivedCents > expected.highCents + tolerance) return { ...base, status: "over", shortfallCents: 0 };
  return { ...base, status: "paid", shortfallCents: 0 };
}
