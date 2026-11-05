// Per-load contribution margin (Reliability Unit D, ruling D-02). Pure.
//   margin = operational load revenue - directly attributable costs
// where "directly attributable" means ONLY expenses and fuel purchases that carry
// this load's id - assigned by the owner, never inferred from date or truck. Truck
// overhead (maintenance, insurance, permits, financing, depreciation) and
// unassigned fuel are NOT in it, and the result says so. The figure is called
// "contribution margin" everywhere, never "profit", and "operational load revenue",
// never cash received or settled revenue. For a load that is not delivered the rate
// is pipeline, so the margin is PROVISIONAL.

export interface EconomicsLoad {
  rate_cents: number | null;
  status: string;
  delivery_date: string | null;
}

export interface LoadEconomics {
  revenueCents: number | null;
  directExpensesCents: number;
  directFuelCents: number;
  /** null when the load has no rate recorded. */
  contributionMarginCents: number | null;
  /** True until the load is delivered (completed with a delivery date): the rate is pipeline, not recognized. */
  provisional: boolean;
  /** Always stated beside the number. */
  excluded: string;
  /** Plain words for the one thing most likely to mislead. */
  caveat: string | null;
}

export const EXCLUDED_NOTE = "truck overhead (maintenance, insurance, permits, financing, depreciation) and fuel not assigned to a load";

export function computeLoadEconomics(load: EconomicsLoad, expenseCents: number[], fuelCents: number[]): LoadEconomics {
  const directExpensesCents = expenseCents.reduce((t, c) => t + c, 0);
  const directFuelCents = fuelCents.reduce((t, c) => t + c, 0);
  const revenueCents = load.rate_cents;
  const delivered = load.status === "completed" && !!load.delivery_date;
  const margin = revenueCents === null ? null : revenueCents - directExpensesCents - directFuelCents;
  let caveat: string | null = null;
  if (revenueCents === null) caveat = "This load has no rate recorded, so there is no margin to show.";
  else if (directFuelCents === 0) caveat = "No fuel is assigned to this load, so this margin may read higher than it really was.";
  return {
    revenueCents,
    directExpensesCents,
    directFuelCents,
    contributionMarginCents: margin,
    provisional: !delivered,
    excluded: EXCLUDED_NOTE,
    caveat,
  };
}
