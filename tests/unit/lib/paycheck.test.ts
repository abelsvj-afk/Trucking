import { describe, expect, it } from "vitest";
import { checkLoad, termsForDate, type PayTermsRow } from "@/lib/paycheck";
import type { ProjectableLoad } from "@/lib/pay-projection";

const row = (over: Partial<PayTermsRow> = {}): PayTermsRow => ({
  employer_name: "Acme", rate_cents_per_mile: 55, mile_basis: "loaded", effective_from: "2026-10-01", effective_to: null, ...over,
});
const load = (over: Partial<ProjectableLoad> = {}): ProjectableLoad => ({
  id: "L", origin: "A", destination: "B", status: "completed", miles: 1000, loaded_miles: 900, deadhead_miles: 100,
  pickup_date: "2026-11-01", delivery_date: "2026-11-03", ...over,
});

describe("termsForDate - the rate in force on the delivery date", () => {
  const old = row({ rate_cents_per_mile: 50, effective_from: "2026-01-01", effective_to: "2026-10-31" });
  const current = row({ rate_cents_per_mile: 55, effective_from: "2026-11-01" });
  it("picks the dated row that covers the date, so a later rate change never reprices an old load", () => {
    expect(termsForDate([old, current], "2026-09-15")!.terms.rate_cents_per_mile).toBe(50);
    expect(termsForDate([old, current], "2026-11-03")!.terms.rate_cents_per_mile).toBe(55);
    expect(termsForDate([old, current], "2026-09-15")!.inForce).toBe(true);
  });
  it("no covering row: the nearest one, and it says it was not in force", () => {
    const early = termsForDate([current], "2026-06-01")!;
    expect(early.terms.rate_cents_per_mile).toBe(55);
    expect(early.inForce).toBe(false);
    expect(termsForDate([old], "2026-12-01")!.inForce).toBe(false);
  });
  it("no terms at all: null", () => expect(termsForDate([], "2026-11-01")).toBeNull());
});

describe("checkLoad - expected vs received", () => {
  const rows = [row()];
  it("no pay line names the load: unpaid", () => {
    expect(checkLoad(load(), rows, null)).toMatchObject({ status: "unpaid", shortfallCents: 0 });
  });
  it("received matches: paid; just inside tolerance: paid; beyond: SHORT with the shortfall", () => {
    expect(checkLoad(load(), rows, 49500)!.status).toBe("paid");
    expect(checkLoad(load(), rows, 49500 - 400)!.status).toBe("paid"); // within the $5 tolerance
    const short = checkLoad(load(), rows, 40000)!;
    expect(short.status).toBe("short");
    expect(short.shortfallCents).toBe(9500);
  });
  it("well above expected: over (shown, not a problem)", () => {
    expect(checkLoad(load(), rows, 80000)!.status).toBe("over");
  });
  it("basis unset: a range - short only below the LOW end", () => {
    const r = [row({ mile_basis: null })];
    expect(checkLoad(load(), r, 50000)!.status).toBe("paid"); // between 495.00 and 550.00
    expect(checkLoad(load(), r, 49000 - 600)!.status).toBe("short");
  });
  it("can't compute expected (no mileage): unknown - never flagged", () => {
    expect(checkLoad(load({ miles: null, loaded_miles: null, deadhead_miles: null }), rows, 100)).toMatchObject({ status: "unknown" });
  });
  it("prices with the row in force on the delivery date", () => {
    const hist = [row({ rate_cents_per_mile: 50, effective_from: "2026-01-01", effective_to: "2026-10-31" }), row({ rate_cents_per_mile: 55, effective_from: "2026-11-01" })];
    expect(checkLoad(load({ delivery_date: "2026-10-20" }), hist, null)!.expected.lowCents).toBe(45000);
    expect(checkLoad(load({ delivery_date: "2026-11-03" }), hist, null)!.expected.lowCents).toBe(49500);
  });
});
