// What a load is worth when its own rate is $0.00 or missing (owner order 2026-11-07: "loads have $0.00 rate, calculate from
// miles times $0.55"). Pure. A load that carries a real rate keeps it (source "rate"). A load without one is valued from its miles
// at the pay terms in force on its date - the same projectLoad every pay page uses, so every Money page agrees - and is marked
// "estimated" so no screen presents the estimate as a recorded rate. No miles and no terms = 0 with source "none" (never invented).

import { checkLoad, type PayTermsRow } from "./paycheck";
import type { ProjectableLoad } from "./pay-projection";

export type EarningsSource = "rate" | "estimated" | "none";

export interface LoadEarnings {
  cents: number;
  source: EarningsSource;
  /** The LOW end of the pay range is used while the miles basis is unset (never the optimistic end). */
  rangeHighCents?: number;
}

export function loadEarnings(load: ProjectableLoad & { rate_cents?: number | null }, terms: PayTermsRow[]): LoadEarnings {
  if (load.rate_cents != null && load.rate_cents > 0) return { cents: load.rate_cents, source: "rate" };
  const line = checkLoad(load, terms, null);
  if (!line || line.expected.lowCents === null || line.expected.highCents === null) return { cents: 0, source: "none" };
  return {
    cents: line.expected.lowCents,
    source: "estimated",
    ...(line.expected.highCents !== line.expected.lowCents ? { rangeHighCents: line.expected.highCents } : {}),
  };
}

export interface EarningsTotal {
  cents: number;
  /** How many loads were valued from miles because they carry no rate. */
  estimatedCount: number;
  estimatedCents: number;
  noValueCount: number;
}

export function totalEarnings(loads: (ProjectableLoad & { rate_cents?: number | null })[], terms: PayTermsRow[]): EarningsTotal {
  const t: EarningsTotal = { cents: 0, estimatedCount: 0, estimatedCents: 0, noValueCount: 0 };
  for (const l of loads) {
    const e = loadEarnings(l, terms);
    t.cents += e.cents;
    if (e.source === "estimated") {
      t.estimatedCount += 1;
      t.estimatedCents += e.cents;
    } else if (e.source === "none") t.noValueCount += 1;
  }
  return t;
}
