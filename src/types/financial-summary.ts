// Shape of the computed, read-only endpoint from docs/api-contracts.md.
// Not a stored row (docs/schemas.md), so it lives outside entities.ts.
export interface FinancialSummary {
  range: { from: string; to: string };
  revenue_cents: number;
  expenses_cents: number;
  fuel_cents: number;
  maintenance_cents: number;
  net_cents: number;
}
