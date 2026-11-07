import { describe, expect, it } from "vitest";
import { buildPaySummary } from "@/services/api/pay-summary";
import type { Load } from "@/types/entities";

const terms = [{ employer_name: "Acme", rate_cents_per_mile: 60, mile_basis: "all" as const, effective_from: "2026-01-01", effective_to: null }];
const load = (o: Partial<Load>): Load => ({ id: "l1", origin: "A", destination: "B", status: "completed", miles: 1000, loaded_miles: null, deadhead_miles: null, pickup_date: "2026-10-01", delivery_date: "2026-10-03", deleted_at: null, ...o }) as Load;
const now = new Date("2026-11-05T15:00:00Z");

describe("buildPaySummary", () => {
  it("flags unpaid and short completed loads and totals them", () => {
    const s = buildPaySummary({
      loads: [load({ id: "u" }), load({ id: "s", delivery_date: "2026-10-04" }), load({ id: "p", delivery_date: "2026-10-05" })],
      terms,
      receivedByLoad: new Map([["s", 40000], ["p", 60000]]),
      hos: null,
      now,
    });
    const by = Object.fromEntries(s.completed.map((c) => [c.loadId, c.line?.status]));
    expect(by).toEqual({ u: "unpaid", s: "short", p: "paid" });
    expect(s.totals.unpaidCount).toBe(1);
    expect(s.totals.unpaidLowCents).toBe(60000);
    expect(s.totals.shortCount).toBe(1);
    expect(s.totals.shortfallCents).toBe(20000);
  });
  it("reports no terms honestly", () => {
    const s = buildPaySummary({ loads: [load({})], terms: [], receivedByLoad: new Map(), hos: null, now });
    expect(s.hasTerms).toBe(false);
    expect(s.completed[0]!.line).toBeNull();
  });
  it("gives the active load an hours cost", () => {
    const s = buildPaySummary({ loads: [load({ status: "confirmed", delivery_date: "2026-11-08" })], terms, receivedByLoad: new Map(), hos: null, now });
    expect(s.active?.hosCost?.text).toContain("1,000 mi");
  });

  it("groups finished loads by his Sunday-Saturday pay week with statement and payday, expected vs received", () => {
    const deal = [{ ...terms[0]!, pay_week_ends_on: 6, statement_weekday: 4, payday_weekday: 5 }];
    const s = buildPaySummary({
      loads: [
        load({ id: "a", delivery_date: "2026-10-31", pickup_date: "2026-10-30" }), // Saturday: week Oct 25-31
        load({ id: "b", delivery_date: "2026-10-27", pickup_date: "2026-10-26" }), // same week
        load({ id: "c", delivery_date: "2026-11-01", pickup_date: "2026-10-31" }), // Sunday: next week
      ],
      terms: deal,
      receivedByLoad: new Map([["a", 60000]]),
      hos: null,
      now,
    });
    expect(s.weeks.map((w) => [w.start, w.end, w.statement, w.payday])).toEqual([
      ["2026-11-01", "2026-11-07", "2026-11-12", "2026-11-13"],
      ["2026-10-25", "2026-10-31", "2026-11-05", "2026-11-06"],
    ]);
    const first = s.weeks[1]!;
    expect(first.loadCount).toBe(2);
    expect(first.expectedLowCents).toBe(120000);
    expect(first.receivedCents).toBe(60000);
    expect(first.unpaidCount).toBe(1); // b is on no statement yet
    expect(s.weeks[0]!.loadCount).toBe(1);
  });
  it("with the week unset it still groups (Monday-Sunday) and says the dates aren't set", () => {
    const s = buildPaySummary({ loads: [load({})], terms, receivedByLoad: new Map(), hos: null, now });
    expect(s.weeks).toHaveLength(1);
    expect(s.weeks[0]!.statement).toBeNull();
    expect(s.weeks[0]!.payday).toBeNull();
  });
  it("a load that can't be priced is counted as unpriced, not as $0", () => {
    const s = buildPaySummary({ loads: [load({ miles: null })], terms, receivedByLoad: new Map(), hos: null, now });
    expect(s.weeks[0]).toMatchObject({ unpricedCount: 1, expectedLowCents: 0 });
  });

  it("nets cash advances against their own pay week's expected pay", () => {
    const deal = [{ ...terms[0]!, pay_week_ends_on: 6, statement_weekday: 4, payday_weekday: 5 }];
    const s = buildPaySummary({
      loads: [load({ id: "a", delivery_date: "2026-10-28", pickup_date: "2026-10-27" })], // week Oct 25-31, $600 expected
      terms: deal,
      receivedByLoad: new Map(),
      advances: [
        { amount_cents: 10000, advance_date: "2026-10-27" }, // same week
        { amount_cents: 5000, advance_date: "2026-11-02" }, // next week (Nov 1-7): no finished loads
      ],
      hos: null,
      now,
    });
    const withLoad = s.weeks.find((w) => w.start === "2026-10-25")!;
    expect(withLoad).toMatchObject({ advancesCents: 10000, expectedLowCents: 60000, netLowCents: 50000, netHighCents: 50000 });
    const advanceOnly = s.weeks.find((w) => w.start === "2026-11-01")!;
    expect(advanceOnly).toMatchObject({ loadCount: 0, advancesCents: 5000, netLowCents: -5000, payday: "2026-11-13" });
    expect(s.totals.advancesCents).toBe(15000);
    // The unpaid load's week: $600 expected - $100 advances = $500 net.
    expect(s.totals.unpaidNetLowCents).toBe(50000);
    expect(s.totals.unpaidNetHighCents).toBe(50000);
  });
  it("with no advances the nets equal the gross figures", () => {
    const s = buildPaySummary({ loads: [load({})], terms, receivedByLoad: new Map(), hos: null, now });
    expect(s.totals.advancesCents).toBe(0);
    expect(s.weeks[0]).toMatchObject({ advancesCents: 0, netLowCents: 60000, netHighCents: 60000 });
    expect(s.totals.unpaidNetLowCents).toBe(60000);
  });
});
