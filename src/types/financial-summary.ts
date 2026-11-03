// Shape of the computed, read-only endpoint from docs/api-contracts.md.
// Not a stored row (docs/schemas.md), so it lives outside entities.ts.
export interface FinancialSummary {
  range: { from: string; to: string };
  /**
   * The timezone the summary's period boundaries are computed and
   * reported in (Reliability Unit B, B.2.1): the viewer's zone as
   * carried by the client, or the America/New_York fallback when the
   * client sent none or an invalid one - reported, never silent.
   */
  timeZone: string;
  revenue_cents: number;
  expenses_cents: number;
  fuel_cents: number;
  maintenance_cents: number;
  net_cents: number;
}
