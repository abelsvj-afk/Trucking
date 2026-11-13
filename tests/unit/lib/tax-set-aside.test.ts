// Tax set-aside (migration 00094, owner order 2026-11-12): the math is
// gross x %, the 25% default applies while no percent is stored, and
// the line shows ONLY for a 1099 contractor - W2 and NULL (UNSET)
// worker_type show nothing. Display only; it never moves money.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TAX_SET_ASIDE_BPS,
  describeTaxSetAside,
  isContractor,
  taxSetAsideBps,
  taxSetAsideCents,
  taxSetAsideFor,
  taxSetAsidePercent,
  workerTypeLabel,
} from "@/lib/tax-set-aside";

describe("tax set-aside math", () => {
  it("is 25% of gross by default (owner's live check: 25% of $611.20 is $152.80)", () => {
    expect(DEFAULT_TAX_SET_ASIDE_BPS).toBe(2500);
    expect(taxSetAsideBps(null)).toBe(2500);
    expect(taxSetAsideBps(undefined)).toBe(2500);
    expect(taxSetAsideCents(61120, 2500)).toBe(15280);
  });

  it("respects a stored custom percent", () => {
    expect(taxSetAsideBps(3000)).toBe(3000);
    expect(taxSetAsidePercent(3000)).toBe(30);
    expect(taxSetAsideCents(61120, 3000)).toBe(18336);
  });

  it("rounds to whole cents", () => {
    expect(taxSetAsideCents(10001, 2500)).toBe(2500); // 2500.25 -> 2500
    expect(taxSetAsideCents(10003, 2500)).toBe(2501); // 2500.75 -> 2501
  });
});

describe("tax set-aside display conditions", () => {
  it("shows for a 1099 contractor at the default 25% while no percent is stored", () => {
    const s = taxSetAsideFor(61120, 61120, "1099", null);
    expect(s).toEqual({ bps: 2500, isDefault: true, lowCents: 15280, highCents: 15280 });
    expect(describeTaxSetAside(s!, 61120, 61120)).toBe("Set aside for taxes: $152.80 (25% of $611.20 gross)");
  });

  it("shows a range set-aside for a range gross", () => {
    const s = taxSetAsideFor(100000, 120000, "1099", null);
    expect(s!.lowCents).toBe(25000);
    expect(s!.highCents).toBe(30000);
    expect(describeTaxSetAside(s!, 100000, 120000)).toBe("Set aside for taxes: $250.00 – $300.00 (25% of $1,000.00 – $1,200.00 gross)");
  });

  it("shows a stored custom percent and marks it as not the default", () => {
    const s = taxSetAsideFor(61120, 61120, "1099", 3000);
    expect(s).toEqual({ bps: 3000, isDefault: false, lowCents: 18336, highCents: 18336 });
    expect(describeTaxSetAside(s!, 61120, 61120)).toBe("Set aside for taxes: $183.36 (30% of $611.20 gross)");
  });

  it("hides for a W2 profile", () => {
    expect(isContractor("w2")).toBe(false);
    expect(taxSetAsideFor(61120, 61120, "w2", null)).toBeNull();
    expect(taxSetAsideFor(61120, 61120, "w2", 3000)).toBeNull();
  });

  it("hides while the worker type is still NULL (UNSET) - no crash, no line", () => {
    expect(isContractor(null)).toBe(false);
    expect(isContractor(undefined)).toBe(false);
    expect(taxSetAsideFor(61120, 61120, null, null)).toBeNull();
    expect(taxSetAsideFor(61120, 61120, undefined, 3000)).toBeNull();
  });

  it("labels the worker type for the pay profile", () => {
    expect(workerTypeLabel("1099")).toBe("1099 contractor");
    expect(workerTypeLabel("w2")).toBe("W2 employee");
    expect(workerTypeLabel(null)).toBeNull();
    expect(workerTypeLabel(undefined)).toBeNull();
  });
});
