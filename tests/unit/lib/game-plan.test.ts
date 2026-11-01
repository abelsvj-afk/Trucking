// Gaming System engine (docs/design/gaming-system.md §§2-5).
// The engine is deterministic code - these tests pin the math the
// owner will steer by: gap arithmetic, the three lines and the
// posture rule, the §3.4 citation fence, the §3.2 authority-aging
// rule, the §5.5 STABILIZE validity fence and its nearest-valid
// repair, version diffing, and checkpoint verdicts. Fixtures use
// round numbers so every expectation is hand-checkable:
//   net $1,800/wk -> $7,800/mo; sweep rule 50% -> $3,900/mo to the
//   fund; his actual pace 10% -> $780/mo. Truck crossing (price
//   $20,000 + reserve $5,000 + startup $12,000) = $37,000.

import { describe, expect, it } from "vitest";
import {
  buildAssumptions,
  dataSufficiency,
  gamePlan,
  makeNearestValid,
  validateScenarios,
  EMERGENCY_CUSHION_FLOOR_CENTS,
  HOS_WEEKLY_ON_DUTY_CAP_HOURS,
  type GameSnapshot,
  type SideLever,
  type TargetLike,
} from "@/lib/game-plan";
import {
  allowedFigureSet,
  buildCheckpointDigest,
  checkpointVerdict,
  computePlanDiff,
  extractDollarFiguresCents,
  findBannedPhrases,
  findUngroundedFigures,
} from "@/lib/game-text";

const baseSnapshot: GameSnapshot = {
  asOf: "2026-11-15",
  netPerWeekCents: { w4: 180_000, w8: 180_000, w12: 180_000 },
  grossRevenuePerWeekCents: 400_000,
  loadsPerWeek: 3,
  avgNetPerLoadCents: 60_000,
  completedLoads: 24,
  fuelCentsPerMonth: 0,
  fuelGallonsPerMonth: 0,
  maintenanceCentsPerMonth: 0,
  fixedCostsCentsPerMonth: 0,
  recentMaintenance: [],
  truckFundBalanceCents: 0,
  emergencyFundBalanceCents: 1_200_000,
  businessCreditBalanceCents: 0,
  fundTargetCents: 2_000_000,
  fundTargetBand: null,
  sweepRulePct: 50,
  actualSavingsRatePct: 10,
  actualMonthlySavingsCents: 78_000,
  driveHoursPerWeek: 40,
  onDutyHoursPerWeek: 50,
  mcAge: { status: "not_started" },
  latestBriefings: [],
  sideIncomeCandidates: [],
  knownDebtsCents: 0,
  personalSnapshotCents: 0,
  weeksOfHistory: 12,
};

const fundTarget: TargetLike = {
  metric: "truck_fund_cents",
  targetValueCents: 2_500_000,
  targetDate: "2027-05-31",
  posture: "conservative",
  postureMixPct: 0,
};

function game(snapshot: GameSnapshot, target: TargetLike, overrides: Record<string, unknown> = {}) {
  const built = buildAssumptions({ snapshot, persistentOverrides: {}, oneOffOverrides: overrides });
  const input = { snapshot, target, values: built.values };
  return { built, input, output: gamePlan(input) };
}

const citedLever: SideLever = {
  key: "weekend-detailing",
  label: "Weekend detailing (from briefing)",
  sourceType: "briefing",
  sourceId: "briefing-1",
  monthlyLowCents: 50_000,
  monthlyHighCents: 80_000,
  hoursPerWeek: 5,
  startupCents: 0,
  seasonality: null,
  startMonth: null,
};

const citedSnapshot: GameSnapshot = {
  ...baseSnapshot,
  sideIncomeCandidates: [{ sourceType: "briefing", sourceId: "briefing-1", label: "Detailing demand brief" }],
};

describe("gap math and the three lines", () => {
  it("computes the gap at the target date from the frozen series", () => {
    const { output } = game(baseSnapshot, fundTarget);
    // 7 months (2026-11..2027-05): pace $780/mo, conservative $3,900/mo.
    expect(output.gap.currentPaceCents).toBe(546_000);
    expect(output.gap.conservativeCents).toBe(2_730_000);
    expect(output.gap.recommendedCents).toBe(2_730_000);
    expect(output.scenarios.currentPace.shortfallCents).toBe(2_500_000 - 546_000);
    expect(output.scenarios.conservative.shortfallCents).toBe(0);
    // Gap closed on the recommended path -> no closers block.
    expect(output.gap.closers).toBeNull();
    // No truck window inside the horizon -> no authority either.
    expect(output.scenarios.recommended.milestones.truckWindowMonth).toBeNull();
    expect(output.scenarios.recommended.milestones.authorityMonth).toBeNull();
  });

  it("itemizes the sweep lever's contribution as engine arithmetic", () => {
    const { output } = game(baseSnapshot, fundTarget);
    const sweep = output.levers.find((l) => l.key === "sweep");
    expect(sweep?.contributionCents).toBe(2_730_000 - 546_000);
  });

  it("names the honest closers when no path reaches the target", () => {
    const { output } = game(baseSnapshot, { ...fundTarget, targetValueCents: 4_000_000 });
    expect(output.gap.closers?.reachableAtTargetDateCents).toBe(2_730_000);
    // Short $12,700 at +$3,900/mo -> 4 extra months.
    expect(output.gap.closers?.extraMonthsAtRecommendedPace).toBe(4);
  });

  it("answers a monthly-net target with the month's net", () => {
    const { output } = game(baseSnapshot, {
      metric: "monthly_net_cents",
      targetValueCents: 700_000,
      targetDate: "2027-05-31",
      posture: "conservative",
      postureMixPct: 0,
    });
    expect(output.gap.conservativeCents).toBe(780_000);
    expect(output.scenarios.conservative.shortfallCents).toBe(0);
  });
});

describe("posture and the mixed line (§§1.1/3.4)", () => {
  const mixedTarget: TargetLike = {
    metric: "truck_fund_cents",
    targetValueCents: 3_000_000,
    targetDate: "2027-05-31",
    posture: "mixed",
    postureMixPct: 100,
  };

  it("admits a cited lever into the recommended path up to the posture allowance", () => {
    const { output } = game(citedSnapshot, mixedTarget, { side_income_levers: [citedLever] });
    // Lever adds $500/mo net -> +$250/mo swept -> +$1,750 by target month.
    expect(output.gap.mixedCents).toBe(2_905_000);
    expect(output.gap.recommendedCents).toBe(2_905_000);
    expect(output.mixedDeclinedByPosture).toBe(false);
    const side = output.levers.find((l) => l.key === "side:weekend-detailing");
    expect(side?.contributionCents).toBe(175_000);
    expect(side?.source).toBe("research briefing briefing-1");
  });

  it("renders the mixed line at conservative posture, labelled declined, and keeps it out of the recommendation", () => {
    const { output } = game(citedSnapshot, { ...mixedTarget, posture: "conservative", postureMixPct: 0 }, { side_income_levers: [citedLever] });
    expect(output.gap.mixedCents).toBe(2_905_000);
    expect(output.gap.recommendedCents).toBe(2_730_000);
    expect(output.mixedDeclinedByPosture).toBe(true);
  });

  it("drops a lever whose citation names nothing the snapshot surfaced", () => {
    const { built } = game(baseSnapshot, mixedTarget, { side_income_levers: [citedLever] });
    expect(built.values.sideLevers).toHaveLength(0);
  });

  it("keeps a lever whose citation matches a surfaced candidate", () => {
    const { built } = game(citedSnapshot, mixedTarget, { side_income_levers: [citedLever] });
    expect(built.values.sideLevers).toHaveLength(1);
  });
});

describe("assumption sheet sources (§2.3/§2.5)", () => {
  it("labels his data, vision estimates, and overrides distinctly", () => {
    const { built } = game(baseSnapshot, fundTarget, { fuel_price_cents_gal: 550 });
    const byKey = new Map(built.sheet.map((e) => [e.key, e]));
    expect(byKey.get("truck_price_cents")?.source).toBe("his_data");
    expect(byKey.get("repair_reserve_cents")?.source).toBe("vision_estimate");
    expect(byKey.get("insurance_annual_cents")?.source).toBe("vision_estimate");
    expect(byKey.get("fuel_price_cents_gal")?.value).toBe(550);
    expect(byKey.get("fuel_price_cents_gal")?.source).toBe("his_override");
    expect(byKey.get("net_per_week_cents")?.source).toBe("his_data");
  });

  it("stamps thin data honestly", () => {
    expect(dataSufficiency(baseSnapshot).thinData).toBe(false);
    expect(dataSufficiency({ ...baseSnapshot, completedLoads: 3 }).thinData).toBe(true);
    expect(dataSufficiency({ ...baseSnapshot, weeksOfHistory: 2 }).thinData).toBe(true);
  });
});

describe("the authority-aging rule (§3.2)", () => {
  const openTarget: TargetLike = {
    metric: "truck_fund_cents",
    targetValueCents: 9_000_000,
    targetDate: null,
    posture: "conservative",
    postureMixPct: 0,
  };

  it("files at the truck window by default (fund crosses $37,000 in month 10)", () => {
    const { output } = game(baseSnapshot, openTarget);
    const m = output.scenarios.conservative.milestones;
    expect(m.truckWindowMonth).toBe("2027-08");
    expect(m.authorityMonth).toBe("2027-08");
    expect(m.authorityReason).toBeNull();
  });

  it("pushes an early activation to the truck window, with the reason in one line", () => {
    const { output } = game(baseSnapshot, openTarget, { authority_activation_month: "2027-01" });
    const m = output.scenarios.conservative.milestones;
    expect(m.authorityMonth).toBe("2027-08");
    expect(m.authorityReason).toContain("Authority waits for the truck window");
  });
});

describe("the STABILIZE validity fence (§5.5)", () => {
  it("refuses financing while the cushion runs below its floor, and the nearest-valid repair removes it", () => {
    const poor = { ...baseSnapshot, emergencyFundBalanceCents: 500_000 };
    const { input, output } = game(poor, fundTarget, { truck_financing_cents: 1_000_000 });
    const violations = validateScenarios(input, output);
    expect(violations.map((v) => v.rule)).toContain("leverage_before_cushion");

    const nearest = makeNearestValid(input, violations);
    expect(nearest.values.truckFinancingCents).toBe(0);
    expect(nearest.removed.join(" ")).toContain("truck financing of $10,000");
    const repaired = gamePlan({ ...input, values: nearest.values });
    expect(validateScenarios({ ...input, values: nearest.values }, repaired).map((v) => v.rule)).not.toContain(
      "leverage_before_cushion",
    );
  });

  it("allows financing when the cushion never dips below the floor", () => {
    const { input, output } = game(baseSnapshot, fundTarget, { truck_financing_cents: 1_000_000 });
    expect(output.scenarios.recommended.minCushionCents).toBeGreaterThanOrEqual(EMERGENCY_CUSHION_FLOOR_CENTS);
    expect(validateScenarios(input, output).map((v) => v.rule)).not.toContain("leverage_before_cushion");
  });

  it("refuses a week scheduled past the legal hours ceiling, and the repair drops the lever", () => {
    const busy: GameSnapshot = { ...citedSnapshot, onDutyHoursPerWeek: 55 };
    const heavyLever: SideLever = { ...citedLever, hoursPerWeek: 10 };
    const target: TargetLike = {
      metric: "truck_fund_cents",
      targetValueCents: 3_000_000,
      targetDate: "2027-05-31",
      posture: "mixed",
      postureMixPct: 100,
    };
    const { input, output } = game(busy, target, { side_income_levers: [heavyLever] });
    expect(output.scenarios.recommended.demands.totalHoursPerWeek).toBe(65);
    expect(output.scenarios.recommended.demands.exceedsLegalHours).toBe(true);
    const violations = validateScenarios(input, output);
    expect(violations.map((v) => v.rule)).toContain("hos_illegal");

    const nearest = makeNearestValid(input, violations);
    expect(nearest.values.sideLevers).toHaveLength(0);
    expect(nearest.removed.join(" ")).toContain("legal hours ceiling");
    const repaired = gamePlan({ ...input, values: nearest.values });
    expect(repaired.scenarios.recommended.demands.totalHoursPerWeek).toBeLessThanOrEqual(HOS_WEEKLY_ON_DUTY_CAP_HOURS);
  });

  it("refuses an authority window whose insurance year the fund cannot hold", () => {
    const rich: GameSnapshot = { ...baseSnapshot, truckFundBalanceCents: 3_000_000 };
    const openTarget: TargetLike = {
      metric: "truck_fund_cents",
      targetValueCents: 9_000_000,
      targetDate: null,
      posture: "conservative",
      postureMixPct: 0,
    };
    const { input, output } = game(rich, openTarget, { insurance_annual_cents: 6_000_000 });
    expect(output.scenarios.conservative.milestones.authorityMonth).toBe("2026-12");
    expect(validateScenarios(input, output).map((v) => v.rule)).toContain("insurance_lapse");

    const control = game(rich, openTarget);
    expect(validateScenarios(control.input, control.output).map((v) => v.rule)).not.toContain("insurance_lapse");
  });

  it("flags the S-corp zone from trailing net, both ways", () => {
    const rich = game(baseSnapshot, fundTarget);
    expect(rich.output.scenarios.conservative.milestones.sCorpFlag).toBe(true); // $93,600 trailing
    const lean = game(
      { ...baseSnapshot, netPerWeekCents: { w4: 50_000, w8: 50_000, w12: 50_000 } },
      fundTarget,
    );
    expect(lean.output.scenarios.conservative.milestones.sCorpFlag).toBe(false); // $26,000 trailing
  });
});

describe("plan diffing (§4.2)", () => {
  it("writes the first-plan diff", () => {
    const { built, output } = game(baseSnapshot, fundTarget);
    const diff = computePlanDiff({
      previous: null,
      nextVersion: 1,
      next: output,
      nextAssumptions: built.sheet,
      trigger: "target_set",
      materialityPct: 2,
      targetChanged: true,
    });
    expect(diff.material).toBe(true);
    expect(diff.previousVersion).toBeNull();
    expect(diff.text).toContain("First plan for this target");
  });

  it("marks a real change material and an identical re-game immaterial", () => {
    const first = game(baseSnapshot, fundTarget);
    const previous = {
      version: 2,
      trigger: "target_set",
      assumptions: first.built.sheet,
      scenarios: first.output,
    };
    const weaker = game(baseSnapshot, fundTarget, { sweep_pct: 25 });
    const changed = computePlanDiff({
      previous,
      nextVersion: 3,
      next: weaker.output,
      nextAssumptions: weaker.built.sheet,
      trigger: "manual",
      materialityPct: 2,
      targetChanged: false,
    });
    expect(changed.text).toContain("Plan v3 (was v2)");
    expect(changed.gapDeltaCents).toBe(-1_135_000);
    expect(changed.material).toBe(true);
    expect(changed.assumptionChanges.map((c) => c.key)).toContain("sweep_pct");

    const same = computePlanDiff({
      previous,
      nextVersion: 3,
      next: first.output,
      nextAssumptions: first.built.sheet,
      trigger: "manual",
      materialityPct: 2,
      targetChanged: false,
    });
    expect(same.gapDeltaCents).toBe(0);
    expect(same.material).toBe(false);
  });
});

describe("narration honesty fence (§5)", () => {
  it("catches banned promise language", () => {
    expect(findBannedPhrases("This route is guaranteed to work")).toContain("guaranteed");
    expect(findBannedPhrases("A projection, not a promise")).toEqual([]);
  });

  it("grounds dollar figures against the plan's own numbers", () => {
    const allowed = allowedFigureSet([{ gap_cents: 273_000_000, nested: [{ x_cents: 546_000 }] }]);
    expect(extractDollarFiguresCents("Lands at $5,460 by then")).toEqual([546_000]);
    expect(findUngroundedFigures("Lands at $5,460 by then", allowed)).toEqual([]);
    expect(findUngroundedFigures("You could see $9,999 instead", allowed)).toEqual([999_900]);
  });
});

describe("checkpoint verdicts and digest (§4.3)", () => {
  it("grades within a 2% band", () => {
    expect(checkpointVerdict({ plannedCents: 100_000, actualCents: 100_000, hasRecords: true })).toBe("on_plan");
    expect(checkpointVerdict({ plannedCents: 100_000, actualCents: 103_000, hasRecords: true })).toBe("ahead");
    expect(checkpointVerdict({ plannedCents: 100_000, actualCents: 90_000, hasRecords: true })).toBe("behind");
    expect(checkpointVerdict({ plannedCents: 100_000, actualCents: null, hasRecords: true })).toBe("no_data");
    expect(checkpointVerdict({ plannedCents: 100_000, actualCents: 100_000, hasRecords: false })).toBe("no_data");
  });

  it("builds the one-message digest with verdict, cause, and one lever", () => {
    const digest = buildCheckpointDigest({
      monthLabel: "October",
      planVersion: 4,
      metricLabel: "Monthly net",
      verdict: "behind",
      gapCents: -50_000,
      causeLine: "maintenance ran $1,900 over the month's usual",
      truckWindowMonth: "2027-08",
      leverNote: "hold the course",
    });
    expect(digest).toContain("behind by $500");
    expect(digest).toContain("projection");
    expect(digest).toContain("Your lever for next month: hold the course");
  });
});
