// Shape of the computed, read-only endpoint from docs/api-contracts.md.
// Not a stored row (docs/schemas.md), so it lives outside entities.ts.

/**
 * The revenue convention travels with the data (design C.2): the API
 * names the rule it computed under, and the UI renders its label from
 * this field - the label cannot drift from the logic.
 */
export const REVENUE_CONVENTION = "recognized_on_delivery" as const;

export function revenueConventionLabel(convention: string): string {
  return convention === REVENUE_CONVENTION
    ? "Operational revenue — loads delivered; not payments received"
    : "Revenue";
}

/** One component's snapshot-verified total (design C.3): the total,
 * the in-snapshot row count, and the IDs of the rows that make it up -
 * count must equal the number of IDs, or the summary is unverified. */
export interface FinancialComponentTotal {
  total_cents: number;
  row_count: number;
  record_ids: string[];
}

export interface FinancialSummary {
  range: { from: string; to: string };
  /**
   * The timezone the summary's period boundaries are computed and
   * reported in (Reliability Unit B, B.2.1): the viewer's zone as
   * carried by the client, or the America/New_York fallback when the
   * client sent none or an invalid one - reported, never silent.
   * Unit C (C1): the boundaries are now computed IN this zone.
   */
  timeZone: string;
  /** D-01's convention string, verbatim from the API (C.2/C.7.8). */
  revenueConvention: string;
  /** Operational load revenue recognized on delivery (D-01). Never
   * cash received, never a settlement or tax figure (C.3 labeling). */
  revenue_cents: number;
  expenses_cents: number;
  fuel_cents: number;
  maintenance_cents: number;
  /** The period operating result (measure ii): recognized revenue
   * minus every cost incurred in the period. Kept under the legacy
   * field name for existing consumers; measures.periodOperatingResult
   * carries the same value under its own name. */
  net_cents: number;
  components: {
    revenue: FinancialComponentTotal;
    expenses: FinancialComponentTotal;
    fuel: FinancialComponentTotal;
    maintenance: FinancialComponentTotal;
  };
  /** Booked, not yet delivered (draft + confirmed loads): shown
   * separately, never added to revenue or net (D-01). */
  pipeline: FinancialComponentTotal & { loadsWithoutRateCount: number };
  /** Delivered loads in the range with no rate, valued from miles x the pay terms in force. Separate from, and never added to, revenue_cents. null = none, or the estimate could not be made. */
  estimatedPay?: { cents: number; loadCount: number; unvaluedCount: number } | null;
  exceptions: {
    /** Completed loads with no delivery date: excluded from revenue
     * and surfaced here, never silently dropped (C.2). */
    completedMissingDeliveryDate: { count: number; record_ids: string[] };
  };
  /** The three measures under their own names (C.3) - never
   * substituted for one another. Values in cents. */
  measures: {
    recognizedRevenue: number;
    periodOperatingResult: number;
    aggregateContributionMargin: number;
    /** Fuel bought in the period and assigned to no load (Unit D, D-02) - in the operating result, in no load's margin. */
    fuelNotAssigned?: number;
  };
}

/** GET /api/v1/financial-summary/detail response (F-010): the rows
 * behind one component total, read under the same snapshot mechanism;
 * the rows' amounts sum exactly to total_cents. */
export interface FinancialSummaryDetail {
  component: "revenue" | "expenses" | "fuel" | "maintenance";
  range: { from: string; to: string };
  timeZone: string;
  total_cents: number;
  row_count: number;
  rows: Record<string, unknown>[];
}
