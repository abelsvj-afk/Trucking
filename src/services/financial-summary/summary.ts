// Reliability Unit C: composition of the summary response's measures
// from one snapshot read. Kept separate from the route so the measure
// wiring is unit-testable without the transaction machinery.

import { classifyIncurred, type SummaryRange } from "./filter";
import { computeMeasures, type AssignedCost, type MeasureResults } from "./measures";
import type { SummarySnapshotData } from "./snapshot";

export function computeSummaryMeasures(
  data: SummarySnapshotData,
  range: SummaryRange,
): MeasureResults {
  const assignedCosts: AssignedCost[] = data.assignedExpenses.map((expense) => ({
    loadId: expense.load_id,
    amountCents: expense.amount_cents,
    incurred: classifyIncurred(expense.expense_date, range),
  }));

  return computeMeasures({
    recognizedRevenueCents: data.components.revenue.total_cents,
    deliveredLoadIds: new Set(data.components.revenue.record_ids),
    assignedCosts,
    // Until Unit D's F-023 gives fuel a load link, every fuel purchase
    // is unassigned by construction - it lands here, visible as an
    // unallocated period cost, never spread across loads (D-02).
    unassignedCostsInPeriodCents:
      data.unassignedExpensesInPeriodCents + data.components.fuel.total_cents,
    otherPeriodCostsCents: data.components.maintenance.total_cents,
    totalCostsInPeriodCents:
      data.components.expenses.total_cents +
      data.components.fuel.total_cents +
      data.components.maintenance.total_cents,
  });
}
