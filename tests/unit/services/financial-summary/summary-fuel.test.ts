import { describe, expect, it } from "vitest";
import { computeSummaryMeasures } from "@/services/financial-summary/summary";
import { bridgeHolds } from "@/services/financial-summary/measures";
import type { SummarySnapshotData } from "@/services/financial-summary/snapshot";

// Unit D (D.5.1, D.5.4): load-assigned fuel is a direct cost of its load; unassigned fuel
// is an unallocated period cost; the C.3 bridge still holds exactly in integer cents.
const range = { from: "2026-11-01", to: "2026-11-30" };
const window = { ...range, fromTs: "2026-11-01T05:00:00Z", toTs: "2026-12-01T05:00:00Z" };
const empty = { total_cents: 0, row_count: 0, record_ids: [] as string[] };

function data(over: Partial<SummarySnapshotData>): SummarySnapshotData {
  return {
    components: {
      revenue: { total_cents: 300000, row_count: 1, record_ids: ["delivered"] },
      expenses: { ...empty },
      fuel: { total_cents: 0, row_count: 0, record_ids: [] },
      maintenance: { ...empty },
    },
    pipeline: { ...empty, loadsWithoutRateCount: 0 },
    completedMissingDeliveryDate: { count: 0, record_ids: [] },
    assignedExpenses: [],
    unassignedExpensesInPeriodCents: 0,
    assignedFuel: [],
    unassignedFuelInPeriodCents: 0,
    ...over,
  } as SummarySnapshotData;
}

describe("computeSummaryMeasures with fuel assignment", () => {
  it("fuel assigned to a delivered load (even bought in October) lowers the margin, not the unallocated line", () => {
    const d = data({
      components: {
        revenue: { total_cents: 300000, row_count: 1, record_ids: ["delivered"] },
        expenses: { ...empty },
        fuel: { total_cents: 20000, row_count: 1, record_ids: ["f-nov"] }, // November fuel, assigned
        maintenance: { ...empty },
      },
      assignedFuel: [
        { load_id: "delivered", amount_cents: 50000, purchased_at: "2026-10-28T12:00:00Z" }, // before P
        { load_id: "delivered", amount_cents: 20000, purchased_at: "2026-11-02T12:00:00Z" }, // in P
      ],
      unassignedFuelInPeriodCents: 0,
    });
    const m = computeSummaryMeasures(d, range, window);
    expect(m.aggregateContributionMarginCents).toBe(300000 - 70000);
    expect(m.periodOperatingResultCents).toBe(300000 - 20000);
    expect(m.bridge.unassignedInPeriodCents).toBe(0);
    expect(bridgeHolds(m)).toBe(true);
  });

  it("unassigned fuel and fuel on an undelivered load keep the bridge exact", () => {
    const d = data({
      components: {
        revenue: { total_cents: 300000, row_count: 1, record_ids: ["delivered"] },
        expenses: { ...empty },
        fuel: { total_cents: 30000, row_count: 2, record_ids: ["a", "b"] },
        maintenance: { ...empty },
      },
      assignedFuel: [{ load_id: "pipeline-load", amount_cents: 12000, purchased_at: "2026-11-10T12:00:00Z" }],
      unassignedFuelInPeriodCents: 18000,
    });
    const m = computeSummaryMeasures(d, range, window);
    expect(m.bridge.directIncurredInPeriodForNotDeliveredCents).toBe(12000);
    expect(m.bridge.unassignedInPeriodCents).toBe(18000);
    expect(m.aggregateContributionMarginCents).toBe(300000);
    expect(bridgeHolds(m)).toBe(true);
  });

  it("a snapshot from before 00069 reads all period fuel as unassigned, as before", () => {
    const d = data({
      components: {
        revenue: { total_cents: 300000, row_count: 1, record_ids: ["delivered"] },
        expenses: { ...empty },
        fuel: { total_cents: 25000, row_count: 1, record_ids: ["a"] },
        maintenance: { ...empty },
      },
      unassignedFuelInPeriodCents: null,
    });
    const m = computeSummaryMeasures(d, range, window);
    expect(m.bridge.unassignedInPeriodCents).toBe(25000);
    expect(bridgeHolds(m)).toBe(true);
  });
});
