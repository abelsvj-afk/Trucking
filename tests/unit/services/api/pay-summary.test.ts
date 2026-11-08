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

describe("loadPaySummary: a money figure never presents as final when part of its inputs failed to load", () => {
  // A query-builder fake: every table answers from `tables`; each result is thenable like supabase-js's builders.
  function fakeClient(tables: Record<string, { data?: unknown[]; error?: { message: string } }>) {
    const builder = (table: string) => {
      const result = { data: tables[table]?.data ?? [], error: tables[table]?.error ?? null };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "in", "not", "order", "limit", "gte", "lte", "lt", "gt"]) b[m] = () => b;
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
      return b;
    };
    return { from: (t: string) => builder(t) } as never;
  }

  it("fails visibly when the advances query errors (it used to return expected pay with zero advances, silently)", async () => {
    const { loadPaySummary } = await import("@/services/api/pay-summary");
    const client = fakeClient({ cash_advances: { error: { message: "boom" } } });
    await expect(loadPaySummary(client, "c")).rejects.toThrow("The paycheck picture could not be loaded.");
  });

  it("still fails visibly for loads, terms and settlement lines (unchanged)", async () => {
    const { loadPaySummary } = await import("@/services/api/pay-summary");
    for (const table of ["loads", "employer_pay_profiles", "settlement_lines"]) {
      await expect(loadPaySummary(fakeClient({ [table]: { error: { message: "x" } } }), "c")).rejects.toThrow("could not be loaded");
    }
  });

  it("loads normally when every query succeeds", async () => {
    const { loadPaySummary } = await import("@/services/api/pay-summary");
    const s = await loadPaySummary(fakeClient({}), "c");
    expect(s.totals.advancesCents).toBe(0);
  });
});

describe("paychecks organised by payday", () => {
  const deal = [{ ...terms[0]!, pay_week_ends_on: 6, statement_weekday: 4, payday_weekday: 5 }];
  const loads = [
    load({ id: "a", delivery_date: "2026-10-31", pickup_date: "2026-10-30" }), // week Oct 25-31, payday Fri Nov 6
    load({ id: "b", delivery_date: "2026-10-27", pickup_date: "2026-10-26" }), // same week / payday
    load({ id: "c", delivery_date: "2026-11-01", pickup_date: "2026-10-31" }), // next week, payday Fri Nov 13
  ];
  const adv = [{ amount_cents: 25000, advance_date: "2026-10-28", driver_id: null }];

  it("per payday: expected total, advances, net, received, still owed - with the loads underneath", () => {
    const s = buildPaySummary({ loads, terms: deal, receivedByLoad: new Map([["a", 60000]]), advances: adv, hos: null, now });
    expect(s.paydays.map((p) => p.payday)).toEqual(["2026-11-13", "2026-11-06"]);
    const p = s.paydays[1]!;
    expect(p.expectedLowCents).toBe(120000);
    expect(p.advancesCents).toBe(25000);
    expect(p.netLowCents).toBe(95000);
    expect(p.receivedCents).toBe(60000);
    expect(p.stillOwedLowCents).toBe(35000);
    expect(p.loads.map((l) => l.loadId).sort()).toEqual(["a", "b"]); // per-load detail is kept, not replaced
    expect(p.overdue).toBe(false); // payday is Nov 6; "now" is Nov 5 Eastern, so it has not passed
    const later = buildPaySummary({ loads, terms: deal, receivedByLoad: new Map([["a", 60000]]), advances: adv, hos: null, now: new Date("2026-11-07T15:00:00Z") });
    expect(later.paydays[1]!.overdue).toBe(true); // Nov 7 Eastern: payday passed and 35,000 is still owed
  });

  it("is not past due before the payday, and a fully covered payday owes nothing", () => {
    const s = buildPaySummary({ loads, terms: deal, receivedByLoad: new Map([["a", 60000], ["b", 60000]]), advances: adv, hos: null, now });
    const p = s.paydays[1]!;
    expect(p.stillOwedHighCents).toBeLessThanOrEqual(0);
    expect(p.overdue).toBe(false);
  });

  it("an advance in a week with no finished loads still shows its payday", () => {
    const s = buildPaySummary({ loads: [], terms: deal, receivedByLoad: new Map(), advances: [{ amount_cents: 10000, advance_date: "2026-11-03" }], hos: null, now });
    expect(s.paydays).toHaveLength(1);
    expect(s.paydays[0]).toMatchObject({ advancesCents: 10000, loadCount: 0, netLowCents: -10000 });
  });

  it("the paydays reconcile with the pay weeks (one source of truth)", () => {
    const s = buildPaySummary({ loads, terms: deal, receivedByLoad: new Map([["a", 60000]]), advances: adv, hos: null, now });
    const sum = (f: (x: { expectedLowCents: number; advancesCents: number; receivedCents: number }) => number, xs: { expectedLowCents: number; advancesCents: number; receivedCents: number }[]) => xs.reduce((t, x) => t + f(x), 0);
    for (const f of [(x: { expectedLowCents: number }) => x.expectedLowCents, (x: { advancesCents: number }) => x.advancesCents, (x: { receivedCents: number }) => x.receivedCents]) {
      expect(sum(f as never, s.paydays)).toBe(sum(f as never, s.weeks));
    }
    expect(s.totals.advancesCents).toBe(sum((x) => x.advancesCents, s.paydays));
  });
});
