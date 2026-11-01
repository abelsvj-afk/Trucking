// Truck Fund (docs/design/driver-mvp.md §9). The fund math is the
// money truth of this feature - progress against the bands, settled
// period aggregation, and the suggestion rule (off by default, never
// more than the rule's share, never twice) all get pinned here.

import { describe, expect, it } from "vitest";
import {
  aggregatePeriod,
  buildLadderView,
  computeProgress,
  computeSuggestion,
  monthRange,
  snapshotStaleness,
  summarizeFunds,
  weekRange,
  type FundEntryLike,
} from "@/lib/truck-fund";

function entry(partial: Partial<FundEntryLike>): FundEntryLike {
  return {
    fund_key: "truck_fund",
    kind: "deposit",
    amount_cents: 0,
    entry_date: "2026-10-31",
    source: "manual",
    ...partial,
  };
}

describe("summarizeFunds", () => {
  it("balances deposits minus withdrawals per fund and tracks the newest entry date", () => {
    const funds = summarizeFunds([
      entry({ amount_cents: 50_000, entry_date: "2026-10-20" }),
      entry({ amount_cents: 10_000, entry_date: "2026-10-31" }),
      entry({ kind: "withdrawal", amount_cents: 5_000, entry_date: "2026-10-25" }),
      entry({ fund_key: "emergency_fund", amount_cents: 20_000, entry_date: "2026-10-15" }),
    ]);
    expect(funds.truck_fund.balanceCents).toBe(55_000);
    expect(funds.truck_fund.lastEntryDate).toBe("2026-10-31");
    expect(funds.emergency_fund.balanceCents).toBe(20_000);
    expect(funds.business_credit.balanceCents).toBe(0);
    expect(funds.business_credit.lastEntryDate).toBeNull();
  });
});

describe("computeProgress", () => {
  it("measures progress against the band top when no override is set", () => {
    const progress = computeProgress(1_000_000, "budget", null);
    expect(progress.targetCents).toBe(4_000_000);
    expect(progress.percentOfTarget).toBe(25);
    expect(progress.remainingCents).toBe(3_000_000);
    expect(progress.position).toBe("below_band");
  });

  it("reports in_band inside the band and past_band above it", () => {
    expect(computeProgress(2_500_000, "budget", null).position).toBe("in_band");
    expect(computeProgress(4_500_000, "budget", null).position).toBe("past_band");
    expect(computeProgress(4_500_000, "budget", null).percentOfTarget).toBe(112.5);
    expect(computeProgress(4_500_000, "budget", null).remainingCents).toBe(0);
  });

  it("lets a custom target override the band while position still uses the band", () => {
    const progress = computeProgress(1_000_000, "mid", 2_000_000);
    expect(progress.targetCents).toBe(2_000_000);
    expect(progress.percentOfTarget).toBe(50);
    expect(progress.position).toBe("below_band");
  });

  it("reports no target at all when neither band nor override is set", () => {
    const progress = computeProgress(1_000_000, null, null);
    expect(progress.targetCents).toBeNull();
    expect(progress.percentOfTarget).toBeNull();
    expect(progress.remainingCents).toBeNull();
    expect(progress.position).toBeNull();
  });
});

describe("weekRange / monthRange", () => {
  it("returns the Mon-Sun week containing the date (2026-10-31 is a Saturday)", () => {
    expect(weekRange("2026-10-31")).toEqual({ from: "2026-10-26", to: "2026-11-01" });
    expect(weekRange("2026-10-26")).toEqual({ from: "2026-10-26", to: "2026-11-01" });
    expect(weekRange("2026-11-01")).toEqual({ from: "2026-10-26", to: "2026-11-01" });
  });

  it("returns the calendar month", () => {
    expect(monthRange("2026-10-31")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(monthRange("2026-02-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });
});

describe("aggregatePeriod", () => {
  const range = { from: "2026-10-26", to: "2026-11-01" };

  it("sums settled income and costs inside the range only", () => {
    const totals = aggregatePeriod(
      [
        { rate_cents: 200_000, effective_date: "2026-10-28" },
        { rate_cents: 150_000, effective_date: "2026-10-26" },
        { rate_cents: 999_999, effective_date: "2026-10-25" },
        { rate_cents: 888_888, effective_date: "2026-11-02" },
      ],
      [
        { amount_cents: 40_000, date: "2026-10-29" },
        { amount_cents: 10_000, date: "2026-11-01" },
        { amount_cents: 777_777, date: "2026-11-05" },
      ],
      range,
    );
    expect(totals.settledIncomeCents).toBe(350_000);
    expect(totals.costsCents).toBe(50_000);
    expect(totals.settledNetCents).toBe(300_000);
  });

  it("ignores loads with no effective date and treats null amounts as zero", () => {
    const totals = aggregatePeriod(
      [
        { rate_cents: 100_000, effective_date: null },
        { rate_cents: null, effective_date: "2026-10-28" },
      ],
      [{ amount_cents: null, date: "2026-10-28" }],
      range,
    );
    expect(totals.settledIncomeCents).toBe(0);
    expect(totals.costsCents).toBe(0);
    expect(totals.settledNetCents).toBe(0);
  });
});

describe("computeSuggestion", () => {
  it("suggests nothing when the rule is off (the default)", () => {
    expect(
      computeSuggestion({
        settledNetCents: 100_000,
        rule: { mode: "off", percent: null, flatCents: null },
        alreadySweptCents: 0,
      }),
    ).toBeNull();
  });

  it("computes the percent of settled net, rounding down", () => {
    const suggestion = computeSuggestion({
      settledNetCents: 100_001,
      rule: { mode: "percent", percent: 25, flatCents: null },
      alreadySweptCents: 0,
    });
    expect(suggestion?.amountCents).toBe(25_000);
    expect(suggestion?.text).toBe(
      "$1000.01 settled this week. Your rule sends $250.00 to the Truck Fund.",
    );
  });

  it("computes the flat amount", () => {
    const suggestion = computeSuggestion({
      settledNetCents: 80_000,
      rule: { mode: "flat", percent: null, flatCents: 20_000 },
      alreadySweptCents: 0,
    });
    expect(suggestion?.amountCents).toBe(20_000);
  });

  it("subtracts sweep entries already recorded this period", () => {
    const suggestion = computeSuggestion({
      settledNetCents: 100_000,
      rule: { mode: "percent", percent: 25, flatCents: null },
      alreadySweptCents: 10_000,
    });
    expect(suggestion?.amountCents).toBe(15_000);
  });

  it("suggests nothing once the rule's share is already swept", () => {
    expect(
      computeSuggestion({
        settledNetCents: 100_000,
        rule: { mode: "percent", percent: 25, flatCents: null },
        alreadySweptCents: 25_000,
      }),
    ).toBeNull();
  });

  it("suggests nothing when the week settled at or below zero", () => {
    expect(
      computeSuggestion({
        settledNetCents: 0,
        rule: { mode: "percent", percent: 25, flatCents: null },
        alreadySweptCents: 0,
      }),
    ).toBeNull();
    expect(
      computeSuggestion({
        settledNetCents: -5_000,
        rule: { mode: "flat", percent: null, flatCents: 20_000 },
        alreadySweptCents: 0,
      }),
    ).toBeNull();
  });

  it("suggests nothing when the rule's value is missing", () => {
    expect(
      computeSuggestion({
        settledNetCents: 100_000,
        rule: { mode: "percent", percent: null, flatCents: null },
        alreadySweptCents: 0,
      }),
    ).toBeNull();
  });
});

describe("buildLadderView", () => {
  it("walks the six rungs in the vision's order, first rung unlocked, rest locked", () => {
    const view = buildLadderView([]);
    expect(view.map((step) => step.stepKey)).toEqual([
      "ein",
      "business_bank",
      "duns",
      "tradelines",
      "paydex",
      "real_credit",
    ]);
    expect(view[0]!.unlocked).toBe(true);
    expect(view[1]!.unlocked).toBe(false);
    expect(view.every((step) => step.state === "not_started")).toBe(true);
  });

  it("unlocks the next rung only when every earlier rung is done", () => {
    const view = buildLadderView([
      { step_key: "ein", state: "done", note: null },
      { step_key: "business_bank", state: "in_progress", note: null },
    ]);
    expect(view[1]!.unlocked).toBe(true);
    expect(view[2]!.unlocked).toBe(false);
    expect(view[1]!.state).toBe("in_progress");
  });

  it("flags a rung started before its predecessors are done, without blocking it", () => {
    const view = buildLadderView([{ step_key: "duns", state: "in_progress", note: "applied" }]);
    const duns = view.find((step) => step.stepKey === "duns")!;
    expect(duns.outOfOrder).toBe(true);
    expect(duns.note).toBe("applied");
    expect(view[0]!.outOfOrder).toBe(false);
  });
});

describe("snapshotStaleness", () => {
  it("is current within a week and aging within a month", () => {
    expect(snapshotStaleness("2026-10-31", "2026-10-31").level).toBe("current");
    expect(snapshotStaleness("2026-10-24", "2026-10-31").level).toBe("current");
    expect(snapshotStaleness("2026-10-23", "2026-10-31").level).toBe("aging");
    expect(snapshotStaleness("2026-10-01", "2026-10-31").level).toBe("aging");
  });

  it("is stale past a month and says so plainly", () => {
    const stale = snapshotStaleness("2026-09-30", "2026-10-31");
    expect(stale.level).toBe("stale");
    expect(stale.ageDays).toBe(31);
    expect(stale.label).toBe("Stale — may be out of date");
  });

  it("treats a future-dated snapshot as current rather than negative-aged", () => {
    const future = snapshotStaleness("2026-11-05", "2026-10-31");
    expect(future.level).toBe("current");
    expect(future.ageDays).toBe(0);
  });
});
