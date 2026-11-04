// Reliability Unit C (design C.3 Rev 2): the three financial measures,
// defined once and kept distinct - the summary response names them
// separately (recognizedRevenue, periodOperatingResult,
// aggregateContributionMargin) and no surface may render one under
// another's label.
//
//   (i)  Per-load contribution margin (Unit D's surface): one load's
//        recognized revenue minus the direct costs ASSIGNED to it,
//        whenever incurred. Unit D renders it; the aggregate below is
//        its period sum.
//   (ii) Period operating result (this unit): recognized revenue for
//        period P minus ALL costs incurred in P, assigned or not.
//   (iii) Aggregate contribution margin for loads delivered in P: sum
//        of (i) over the loads delivered in P - their direct costs
//        count whenever incurred, including before P.
//
// The bridge between (ii) and (iii) is the acceptance property
// (C.7.4) and must hold EXACTLY in integer cents:
//
//   PeriodOperatingResult_P = AggMargin_P
//     + D_beforeP(delivered in P) + D_afterP(delivered in P)
//     - D_inP(not delivered in P) - Unassigned_P - OtherPeriod_P
//
// The design's printed split of D_life names the before/in terms; the
// after term is the same cross-period effect in the other direction
// (a cost recorded after P for a load delivered in P enters P's
// margin but not P's result) and is required for the identity to hold
// on arbitrary data - on the design's seeded cases, which carry no
// after-period costs for delivered loads, the two forms coincide.
// "Not delivered in P" is computed as: assigned to a load outside P's
// delivered set - which subsumes the design's draft/confirmed/
// cancelled wording and also covers a cost incurred in P for a load
// delivered in an EARLIER period (also not in any P margin, but in
// P's result). POR is computed independently (revenue minus the
// period's component cost totals), so the identity is a genuine
// cross-check, not a restatement.

export interface AssignedCost {
  loadId: string;
  amountCents: number;
  /** Where the cost's incurred date falls relative to the period. */
  incurred: "before" | "in" | "after";
}

export interface MeasureInputs {
  recognizedRevenueCents: number;
  /** Loads delivered in P (status completed, delivery_date in P). */
  deliveredLoadIds: ReadonlySet<string>;
  /** Direct (load-assigned) costs: expenses with a load_id, plus
   * load-linked fuel once Unit D's F-023 column exists. */
  assignedCosts: readonly AssignedCost[];
  /** Costs incurred in P with no load assignment (incl. all fuel
   * until fuel carries a load link). */
  unassignedCostsInPeriodCents: number;
  /** Other period costs incurred in P (maintenance). */
  otherPeriodCostsCents: number;
  /** Every cost incurred in P: expenses_P + fuel_P + maintenance_P,
   * taken from the snapshot's component totals. */
  totalCostsInPeriodCents: number;
}

export interface MeasureResults {
  recognizedRevenueCents: number;
  /** Measure (iii). */
  aggregateContributionMarginCents: number;
  /** Measure (ii). */
  periodOperatingResultCents: number;
  bridge: {
    directIncurredBeforePeriodForDeliveredCents: number;
    directIncurredInPeriodForDeliveredCents: number;
    directIncurredAfterPeriodForDeliveredCents: number;
    directIncurredInPeriodForNotDeliveredCents: number;
    unassignedInPeriodCents: number;
    otherPeriodCostsCents: number;
  };
}

export function computeMeasures(inputs: MeasureInputs): MeasureResults {
  let beforeDelivered = 0;
  let inDelivered = 0;
  let afterDelivered = 0;
  let inNotDelivered = 0;

  for (const cost of inputs.assignedCosts) {
    if (inputs.deliveredLoadIds.has(cost.loadId)) {
      if (cost.incurred === "before") beforeDelivered += cost.amountCents;
      else if (cost.incurred === "in") inDelivered += cost.amountCents;
      else afterDelivered += cost.amountCents;
    } else if (cost.incurred === "in") {
      inNotDelivered += cost.amountCents;
    }
  }

  const directLifeForDelivered = beforeDelivered + inDelivered + afterDelivered;

  return {
    recognizedRevenueCents: inputs.recognizedRevenueCents,
    aggregateContributionMarginCents: inputs.recognizedRevenueCents - directLifeForDelivered,
    periodOperatingResultCents: inputs.recognizedRevenueCents - inputs.totalCostsInPeriodCents,
    bridge: {
      directIncurredBeforePeriodForDeliveredCents: beforeDelivered,
      directIncurredInPeriodForDeliveredCents: inDelivered,
      directIncurredAfterPeriodForDeliveredCents: afterDelivered,
      directIncurredInPeriodForNotDeliveredCents: inNotDelivered,
      unassignedInPeriodCents: inputs.unassignedCostsInPeriodCents,
      otherPeriodCostsCents: inputs.otherPeriodCostsCents,
    },
  };
}

/**
 * The reconciliation property: the independently computed period
 * operating result must equal the aggregate margin moved across the
 * bridge. Exact integer equality - the C.7.4 acceptance assertion.
 */
export function bridgeHolds(results: MeasureResults): boolean {
  const b = results.bridge;
  return (
    results.periodOperatingResultCents ===
    results.aggregateContributionMarginCents +
      b.directIncurredBeforePeriodForDeliveredCents +
      b.directIncurredAfterPeriodForDeliveredCents -
      b.directIncurredInPeriodForNotDeliveredCents -
      b.unassignedInPeriodCents -
      b.otherPeriodCostsCents
  );
}
