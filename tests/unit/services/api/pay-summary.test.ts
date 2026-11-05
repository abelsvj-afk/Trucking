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
});
