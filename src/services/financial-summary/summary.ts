// Reliability Unit C: composition of the summary response's measures
// from one snapshot read. Kept separate from the route so the measure
// wiring is unit-testable without the transaction machinery.

import { classifyIncurred, type ComponentWindow, type SummaryRange } from "./filter";
import { computeMeasures, type AssignedCost, type MeasureResults } from "./measures";
import type { SummarySnapshotData } from "./snapshot";

export function computeSummaryMeasures(
  data: SummarySnapshotData,
  range: SummaryRange,
  window?: ComponentWindow,
): MeasureResults {
  const assignedCosts: AssignedCost[] = data.assignedExpenses.map((expense) => ({
    loadId: expense.load_id,
    amountCents: expense.amount_cents,
    incurred: classifyIncurred(expense.expense_date, range),
  }));

  // Unit D: load-assigned fuel is a direct cost of its load (classified by the viewer-local
  // window); fuel assigned to none stays an unallocated period cost. A snapshot from before
  // 00069 (null) reads all period fuel as unassigned, exactly as before.
  const fuelWindowKnown = window !== undefined && data.unassignedFuelInPeriodCents !== null;
  if (fuelWindowKnown) {
    const fromMs = Date.parse(window.fromTs);
    const toMs = Date.parse(window.toTs);
    for (const fuel of data.assignedFuel) {
      const at = Date.parse(fuel.purchased_at);
      assignedCosts.push({
        loadId: fuel.load_id,
        amountCents: fuel.amount_cents,
        incurred: at < fromMs ? "before" : at >= toMs ? "after" : "in",
      });
    }
  }
  const unassignedFuelInPeriod = fuelWindowKnown
    ? (data.unassignedFuelInPeriodCents as number)
    : data.components.fuel.total_cents;

  return computeMeasures({
    recognizedRevenueCents: data.components.revenue.total_cents,
    deliveredLoadIds: new Set(data.components.revenue.record_ids),
    assignedCosts,
    // Fuel with no load link lands here, visible as an unallocated period
    // cost, never spread across loads (D-02).
    unassignedCostsInPeriodCents: data.unassignedExpensesInPeriodCents + unassignedFuelInPeriod,
    otherPeriodCostsCents: data.components.maintenance.total_cents,
    totalCostsInPeriodCents:
      data.components.expenses.total_cents +
      data.components.fuel.total_cents +
      data.components.maintenance.total_cents,
  });
}
