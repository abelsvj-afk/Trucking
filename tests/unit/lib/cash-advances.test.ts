// Owner 2026-11-07: cash advances taken out of a pay period net against
// that period's expected pay (docs/design/employer-pay-profile.md section 9).

import { describe, expect, it } from "vitest";
import { advancesForPeriod, groupAdvancesByWeek, netRange, sumAdvances, type AdvanceLike } from "@/lib/cash-advances";
import type { PayTermsRow } from "@/lib/paycheck";

// His deal as data: Sun-Sat week, statement Thursday, payday Friday.
const deal: PayTermsRow[] = [
  {
    employer_name: "Acme", rate_cents_per_mile: 55, mile_basis: null, percent_of_load_bps: null,
    pay_week_ends_on: 6, statement_weekday: 4, payday_weekday: 5,
    effective_from: "2026-01-01", effective_to: null,
  },
];
const adv = (over: Partial<AdvanceLike> = {}): AdvanceLike => ({ amount_cents: 10000, advance_date: "2026-11-04", ...over });

describe("sum and period filter", () => {
  it("sums advances exactly", () => {
    expect(sumAdvances([adv(), adv({ amount_cents: 25050 }), adv({ amount_cents: 1 })])).toBe(35051);
    expect(sumAdvances([])).toBe(0);
  });
  it("keeps only advances inside the period, boundaries included", () => {
    const all = [adv({ advance_date: "2026-11-01" }), adv({ advance_date: "2026-11-07" }), adv({ advance_date: "2026-11-08" }), adv({ advance_date: "2026-10-31" })];
    expect(advancesForPeriod(all, "2026-11-01", "2026-11-07").map((a) => a.advance_date)).toEqual(["2026-11-01", "2026-11-07"]);
  });
});

describe("net range", () => {
  it("subtracts the exact advances total from BOTH ends of the range", () => {
    // Basis UNSET: gross is a range, advances are exact, net stays a range.
    expect(netRange(90000, 110000, 30000)).toEqual({ lowCents: 60000, highCents: 80000 });
  });
  it("an exact gross stays exact", () => {
    expect(netRange(75000, 75000, 75000)).toEqual({ lowCents: 0, highCents: 0 });
  });
  it("goes negative when more was taken than the week pays - never clamped", () => {
    expect(netRange(20000, 20000, 35000)).toEqual({ lowCents: -15000, highCents: -15000 });
  });
});

describe("which payday an advance deducts from", () => {
  it("an advance belongs to the Sun-Sat week containing its date, paid the Friday after", () => {
    const weeks = groupAdvancesByWeek([adv({ advance_date: "2026-11-04" })], deal); // Wednesday
    expect(weeks).toHaveLength(1);
    expect(weeks[0]).toMatchObject({ start: "2026-11-01", end: "2026-11-07", payday: "2026-11-13", totalCents: 10000 });
  });
  it("a Saturday advance and the next Sunday advance fall in different pay weeks", () => {
    const weeks = groupAdvancesByWeek([adv({ advance_date: "2026-11-07" }), adv({ advance_date: "2026-11-08", amount_cents: 5000 })], deal);
    expect(weeks.map((w) => [w.start, w.totalCents])).toEqual([
      ["2026-11-08", 5000],
      ["2026-11-01", 10000],
    ]);
  });
  it("several advances in one week add up under that week's payday", () => {
    const weeks = groupAdvancesByWeek([adv(), adv({ amount_cents: 20000, advance_date: "2026-11-06" })], deal);
    expect(weeks).toHaveLength(1);
    expect(weeks[0]!.totalCents).toBe(30000);
    expect(weeks[0]!.advances).toHaveLength(2);
  });
  it("with no terms the week is the Monday-Sunday default and no payday is invented", () => {
    const weeks = groupAdvancesByWeek([adv({ advance_date: "2026-11-04" })], []);
    expect(weeks[0]).toMatchObject({ start: "2026-11-02", end: "2026-11-08", payday: null });
  });
  it("an advance is grouped by the terms in force on ITS date, not today's", () => {
    const changed: PayTermsRow[] = [
      { ...deal[0]!, pay_week_ends_on: 6, effective_from: "2026-01-01", effective_to: "2026-10-31" },
      { ...deal[0]!, pay_week_ends_on: 0, effective_from: "2026-11-01", effective_to: null },
    ];
    // 2026-10-28 (Wed) under the old Saturday-ending week: Oct 25-31.
    const weeks = groupAdvancesByWeek([adv({ advance_date: "2026-10-28" })], changed);
    expect(weeks[0]).toMatchObject({ start: "2026-10-25", end: "2026-10-31" });
  });
});
