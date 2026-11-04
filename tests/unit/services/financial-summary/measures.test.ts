// Reliability Unit C, C.7.4: the three-measures reconciliation
// property. The seeded dataset deliberately includes the design's
// four cross-period cases:
//   (a) fuel bought in October assigned to a load delivered in
//       November (30000c);
//   (b) an expense assigned in October to a load still undelivered
//       in November (12000c);
//   (c) unassigned fuel (Oct 8000c, Nov 5000c);
//   (d) maintenance (Oct 7000c, Nov 9000c);
// plus: an October-delivered load with its own October expense, a
// November expense on the November load, an unassigned November
// expense, and a November expense on a CANCELLED load (cancelled
// loads carry real costs into the period result, never into a
// margin). Every expected value below is hand-computed; the three
// measures must return three DIFFERENT numbers per period, and the
// bridge must hold exactly in integer cents for both periods.

import { describe, expect, it } from "vitest";
import {
  bridgeHolds,
  computeMeasures,
  type AssignedCost,
} from "@/services/financial-summary/measures";

const L_OCT = "load-oct";
const L_NOV = "load-nov";
const L_UNDELIVERED = "load-undelivered";
const L_CANCELLED = "load-cancelled";

// The full assigned-cost ledger for the seeded world. The October
// view and the November view classify the SAME rows differently -
// that reclassification across the period boundary is the entire
// point of the bridge.
const LEDGER: { loadId: string; amountCents: number; month: "2026-10" | "2026-11" }[] = [
  { loadId: L_NOV, amountCents: 30000, month: "2026-10" }, // (a) fuel
  { loadId: L_UNDELIVERED, amountCents: 12000, month: "2026-10" }, // (b)
  { loadId: L_OCT, amountCents: 6000, month: "2026-10" },
  { loadId: L_NOV, amountCents: 4000, month: "2026-11" },
  { loadId: L_CANCELLED, amountCents: 1500, month: "2026-11" },
];

function costsFor(period: "2026-10" | "2026-11"): AssignedCost[] {
  return LEDGER.map((row) => ({
    loadId: row.loadId,
    amountCents: row.amountCents,
    incurred:
      row.month === period ? "in" : row.month < period ? "before" : "after",
  }));
}

describe("three measures + bridge (C.7.4)", () => {
  it("October: revenue 100000, operating result 37000, aggregate margin 94000 - three different values, bridge exact", () => {
    const results = computeMeasures({
      recognizedRevenueCents: 100000,
      deliveredLoadIds: new Set([L_OCT]),
      assignedCosts: costsFor("2026-10"),
      unassignedCostsInPeriodCents: 8000, // (c) October unassigned fuel
      otherPeriodCostsCents: 7000, // (d) October maintenance
      // expenses 18000 (12000 + 6000) + fuel 38000 (30000 assigned +
      // 8000 unassigned) + maintenance 7000.
      totalCostsInPeriodCents: 63000,
    });

    expect(results.recognizedRevenueCents).toBe(100000);
    expect(results.periodOperatingResultCents).toBe(37000);
    expect(results.aggregateContributionMarginCents).toBe(94000);
    expect(new Set([100000, 37000, 94000]).size).toBe(3);
    expect(bridgeHolds(results)).toBe(true);
    // The design's printed equation (which carries no after-period
    // term) also holds here: no October-delivered load has an
    // after-period cost in this dataset.
    const b = results.bridge;
    expect(b.directIncurredAfterPeriodForDeliveredCents).toBe(0);
    expect(results.periodOperatingResultCents).toBe(
      results.aggregateContributionMarginCents +
        b.directIncurredBeforePeriodForDeliveredCents -
        b.directIncurredInPeriodForNotDeliveredCents -
        b.unassignedInPeriodCents -
        b.otherPeriodCostsCents,
    );
    expect(b.directIncurredInPeriodForNotDeliveredCents).toBe(42000); // (a) 30000 + (b) 12000
  });

  it("November: revenue 200000, operating result 178000, aggregate margin 166000 - three different values, bridge exact", () => {
    const results = computeMeasures({
      recognizedRevenueCents: 200000,
      deliveredLoadIds: new Set([L_NOV]),
      assignedCosts: costsFor("2026-11"),
      unassignedCostsInPeriodCents: 7500, // (c) fuel 5000 + unassigned expense 2500
      otherPeriodCostsCents: 9000, // (d) November maintenance
      // expenses 8000 (4000 + 2500 + 1500) + fuel 5000 + maintenance 9000.
      totalCostsInPeriodCents: 22000,
    });

    expect(results.recognizedRevenueCents).toBe(200000);
    expect(results.periodOperatingResultCents).toBe(178000);
    // The October fuel (a) is a November MARGIN cost (whole life)
    // even though it was an October period cost: 200000 - (30000 + 4000).
    expect(results.aggregateContributionMarginCents).toBe(166000);
    expect(new Set([200000, 178000, 166000]).size).toBe(3);
    expect(bridgeHolds(results)).toBe(true);
    const b = results.bridge;
    expect(b.directIncurredBeforePeriodForDeliveredCents).toBe(30000); // (a) crossing into the margin
    expect(b.directIncurredInPeriodForNotDeliveredCents).toBe(1500); // the cancelled load's cost
  });

  it("generalized bridge: an after-period cost for a delivered load and an in-period cost for an earlier-delivered load still reconcile exactly", () => {
    // P = November. The delivered load also has a December-recorded
    // cost (after); an October-delivered load has a November cost
    // (in, not delivered in P). Neither appears in the design's
    // seeded cases; the identity must hold on arbitrary data.
    const results = computeMeasures({
      recognizedRevenueCents: 50000,
      deliveredLoadIds: new Set([L_NOV]),
      assignedCosts: [
        { loadId: L_NOV, amountCents: 3000, incurred: "in" },
        { loadId: L_NOV, amountCents: 2000, incurred: "after" },
        { loadId: L_OCT, amountCents: 4500, incurred: "in" },
      ],
      unassignedCostsInPeriodCents: 1000,
      otherPeriodCostsCents: 500,
      // In-period costs: 3000 + 4500 + 1000 + 500 = 9000.
      totalCostsInPeriodCents: 9000,
    });

    expect(results.aggregateContributionMarginCents).toBe(50000 - 5000); // whole life: 3000 + 2000
    expect(results.periodOperatingResultCents).toBe(50000 - 9000);
    expect(bridgeHolds(results)).toBe(true);
  });
});
