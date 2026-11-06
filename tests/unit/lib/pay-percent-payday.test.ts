// Owner 2026-11-06: pay by cents-per-mile and/or a percent of the load, his own figure per load,
// and the running pay-week total toward payday (docs/design/employer-pay-profile.md section 8).

import { describe, expect, it } from "vitest";
import {
  describeTerms,
  formatDay,
  paydayAfter,
  projectLoad,
  projectPeriod,
  projectPreviousPeriod,
  weekBounds,
  type PayTerms,
  type ProjectableLoad,
} from "@/lib/pay-projection";

const terms = (over: Partial<PayTerms> = {}): PayTerms => ({
  employer_name: "Acme", rate_cents_per_mile: 0, mile_basis: null, percent_of_load_bps: null, ...over,
});
const load = (over: Partial<ProjectableLoad> = {}): ProjectableLoad => ({
  id: "L1", origin: "A", destination: "B", status: "confirmed", miles: 1000, loaded_miles: 900, deadhead_miles: 100,
  rate_cents: 200000, pickup_date: "2026-11-04", delivery_date: "2026-11-05", ...over,
});

describe("percent of the load", () => {
  it("percent only: needs no miles basis, 85% of a $2,000 load is $1,700", () => {
    const p = projectLoad(terms({ percent_of_load_bps: 8500 }), load());
    expect(p).toMatchObject({ kind: "exact", lowCents: 170000, highCents: 170000 });
    expect(p.counted).toContain("85% of the $2,000.00 load");
  });
  it("a load without a rate cannot get a percent part - never a substituted number", () => {
    const p = projectLoad(terms({ percent_of_load_bps: 8500 }), load({ rate_cents: null }));
    expect(p.kind).toBe("unavailable");
    expect(p.lowCents).toBeNull();
    expect(p.note).toContain("no rate");
  });
  it("fractional percents round to the cent", () => {
    expect(projectLoad(terms({ percent_of_load_bps: 1234 }), load({ rate_cents: 100001 })).lowCents).toBe(12340);
  });
});

describe("cents per mile AND percent", () => {
  it("adds the mile part and the percent part", () => {
    const p = projectLoad(terms({ rate_cents_per_mile: 10, mile_basis: "loaded", percent_of_load_bps: 1000 }), load());
    expect(p.lowCents).toBe(9000 + 20000); // 10c x 900 loaded miles + 10% of $2,000
    expect(p.highCents).toBe(9000 + 20000);
    expect(p.kind).toBe("exact");
  });
  it("an unset miles basis keeps the range, and the percent part rides on both ends", () => {
    const p = projectLoad(terms({ rate_cents_per_mile: 10, percent_of_load_bps: 1000 }), load());
    expect(p.kind).toBe("range");
    expect(p.lowCents).toBe(9000 + 20000);
    expect(p.highCents).toBe(10000 + 20000);
  });
  it("if one part can't be worked out the whole load can't", () => {
    expect(projectLoad(terms({ rate_cents_per_mile: 10, mile_basis: "loaded", percent_of_load_bps: 1000 }), load({ rate_cents: null })).kind).toBe("unavailable");
  });
  it("no rate and no percent: nothing to project, said plainly", () => {
    const p = projectLoad(terms(), load());
    expect(p.kind).toBe("unavailable");
    expect(p.note).toContain("no per-mile rate or percent");
  });
});

describe("his own figure for a load", () => {
  it("wins over the terms and is labeled", () => {
    const p = projectLoad(terms({ rate_cents_per_mile: 55, mile_basis: "all" }), load({ pay_override_cents: 123456 }));
    expect(p).toMatchObject({ kind: "exact", lowCents: 123456, highCents: 123456, overridden: true });
  });
  it("works even when there are no terms at all", () => {
    expect(projectLoad(terms(), load({ pay_override_cents: 50000 })).lowCents).toBe(50000);
  });
  it("a figure of $0 is still his figure (not 'unset')", () => {
    expect(projectLoad(terms({ percent_of_load_bps: 8500 }), load({ pay_override_cents: 0 })).lowCents).toBe(0);
  });
});

describe("pay week and payday", () => {
  it("the week ends on the chosen weekday (0 = Sunday default)", () => {
    expect(weekBounds("2026-11-05")).toEqual({ start: "2026-11-02", end: "2026-11-08" }); // Thu, Mon-Sun
    expect(weekBounds("2026-11-05", 5)).toEqual({ start: "2026-10-31", end: "2026-11-06" }); // ends Friday
    expect(weekBounds("2026-11-06", 5)).toEqual({ start: "2026-10-31", end: "2026-11-06" }); // the end day itself
    expect(weekBounds("2026-11-07", 5)).toEqual({ start: "2026-11-07", end: "2026-11-13" }); // day after = new week
  });
  it("payday is the first chosen weekday AFTER the week ends; unset stays unset", () => {
    expect(paydayAfter("2026-11-08", 5)).toBe("2026-11-13"); // Sunday end -> Friday
    expect(paydayAfter("2026-11-08", 0)).toBe("2026-11-15"); // same weekday as the end -> a full week later
    expect(paydayAfter("2026-11-06", 1)).toBe("2026-11-09");
    expect(paydayAfter("2026-11-08", null)).toBeNull();
  });
  it("the running total adds up, carries the payday, and last week is its own total", () => {
    const t = terms({ percent_of_load_bps: 8500, pay_week_ends_on: 0, payday_weekday: 5 });
    const loads = [
      load({ id: "this1", delivery_date: "2026-11-05" }),
      load({ id: "this2", delivery_date: "2026-11-07", pickup_date: "2026-11-06", rate_cents: 100000 }),
      load({ id: "last", delivery_date: "2026-11-01", pickup_date: "2026-10-30" }),
      load({ id: "draft", status: "draft" }),
    ];
    const week = projectPeriod(t, loads, "2026-11-05");
    expect(week.rows.map((r) => r.load.id)).toEqual(["this1", "this2"]);
    expect(week.lowCents).toBe(170000 + 85000);
    expect(week.payday).toBe("2026-11-13");
    expect(week.weekEndSet).toBe(true);
    const previous = projectPreviousPeriod(t, loads, "2026-11-05");
    expect(previous.start).toBe("2026-10-26");
    expect(previous.end).toBe("2026-11-01");
    expect(previous.rows.map((r) => r.load.id)).toEqual(["last"]); // delivered Sunday Nov 1 = last pay week
    expect(previous.lowCents).toBe(170000);
    expect(previous.payday).toBe("2026-11-06");
  });
  it("each load is priced with the terms in force on its own date", () => {
    const old = terms({ percent_of_load_bps: 5000 });
    const current = terms({ percent_of_load_bps: 9000, payday_weekday: 5 });
    const loads = [load({ id: "a", delivery_date: "2026-11-03" }), load({ id: "b", delivery_date: "2026-11-05" })];
    const week = projectPeriod(current, loads, "2026-11-05", { termsFor: (l) => (l.delivery_date === "2026-11-03" ? old : current) });
    expect(week.lowCents).toBe(100000 + 180000);
  });
  it("the week-end and payday are visibly UNSET when not chosen", () => {
    const week = projectPeriod(terms({ percent_of_load_bps: 8500 }), [load()], "2026-11-05");
    expect(week.weekEndSet).toBe(false);
    expect(week.payday).toBeNull();
  });
});

describe("Sunday-Saturday pay week, Thursday statement, Friday payment", () => {
  const t = terms({ percent_of_load_bps: 8500, pay_week_ends_on: 6, statement_weekday: 4, payday_weekday: 5 });
  it("loads from Sunday through Saturday are in the week; the statement is the next Thursday, the money the Friday after the week", () => {
    const loads = [
      load({ id: "sun", delivery_date: "2026-11-08", pickup_date: "2026-11-07" }),
      load({ id: "sat", delivery_date: "2026-11-14", pickup_date: "2026-11-13" }),
      load({ id: "nextsun", delivery_date: "2026-11-15", pickup_date: "2026-11-14" }),
      load({ id: "prevsat", delivery_date: "2026-11-07", pickup_date: "2026-11-06" }),
    ];
    const week = projectPeriod(t, loads, "2026-11-11"); // a Wednesday
    expect(week.start).toBe("2026-11-08"); // Sunday
    expect(week.end).toBe("2026-11-14"); // Saturday
    expect(week.rows.map((r) => r.load.id)).toEqual(["sun", "sat"]);
    expect(week.lowCents).toBe(2 * 170000);
    expect(week.statement).toBe("2026-11-19"); // Thursday
    expect(week.payday).toBe("2026-11-20"); // Friday
    const last = projectPreviousPeriod(t, loads, "2026-11-11");
    expect([last.start, last.end, last.statement, last.payday]).toEqual(["2026-11-01", "2026-11-07", "2026-11-12", "2026-11-13"]);
    expect(last.rows.map((r) => r.load.id)).toEqual(["prevsat"]);
  });
  it("a load delivered on the Saturday that ends the week counts in that week, on the Saturday itself", () => {
    expect(projectPeriod(t, [load({ delivery_date: "2026-11-14" })], "2026-11-14").rows).toHaveLength(1);
    expect(projectPeriod(t, [load({ delivery_date: "2026-11-14" })], "2026-11-15").rows).toHaveLength(0);
  });
});

describe("words", () => {
  it("describes the terms the way he said them", () => {
    expect(describeTerms(terms({ rate_cents_per_mile: 55 }))).toBe("$0.55/mile");
    expect(describeTerms(terms({ percent_of_load_bps: 8500 }))).toBe("85% of the load");
    expect(describeTerms(terms({ rate_cents_per_mile: 40, percent_of_load_bps: 2000 }))).toBe("$0.40/mile + 20% of the load");
    expect(describeTerms(terms())).toBe("no rate set");
  });
  it("formats a payday without any timezone shift", () => {
    expect(formatDay("2026-11-13")).toBe("Fri, Nov 13");
  });
});
