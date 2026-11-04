// Reliability Unit C (design C.4 Rev 2, C.7.5b): the decimal-safe
// fuel precision contract. The tripwire is the point: naive float
// math (2.675 * 100 = 267.49999... -> Math.round = 267) disagrees
// with exact decimal arithmetic (267.5 -> round-half-up = 268). The
// API computes in integer milligallons; the DB invariant computes in
// numeric - this module is the API half, and it must yield 268.

import { describe, expect, it } from "vitest";
import {
  computeFuelBaseCents,
  deriveFuelTotal,
  gallonsToMilli,
  hasAtMostThreeDecimals,
  LEGACY_FUEL_ADJUSTMENT_REASON,
} from "@/lib/fuel-math";

describe("fuel-math precision contract", () => {
  it("documents the float trap the contract exists to avoid", () => {
    // JS float facts, verified on this runtime: the stored double
    // for 2.675 is below the decimal (toFixed shows it), and the
    // classic divergence is live for other values - 1.005 gal x 100c
    // is exactly 100.5c in decimal (rounds to 101) but float
    // multiplication lands below the half and Math.round gives 100.
    // (For 2.675 x 100 specifically, V8's product happens to round
    // to exactly 267.5 - which is the design's point: float agreement
    // is luck, the integer path is construction.)
    expect((2.675).toFixed(2)).toBe("2.67");
    expect(Math.round(1.005 * 100)).toBe(100);
    expect(deriveFuelTotal(1.005, 100).baseCents).toBe(101);
  });

  it("C.7.5b tripwire: 2.675 gal x 100c = 268c, not 267c", () => {
    expect(deriveFuelTotal(2.675, 100).baseCents).toBe(268);
    expect(computeFuelBaseCents(2675, 100)).toBe(268);
  });

  it("worked examples from C.4: 100.000 x 350 = 35000; 87.432 x 389 = 34011", () => {
    expect(deriveFuelTotal(100, 350).baseCents).toBe(35000);
    expect(deriveFuelTotal(87.432, 389).baseCents).toBe(34011);
  });

  it("rounds half up exactly once: x.xx5 goes up, x.xx4 goes down", () => {
    // 1.001 gal x 500c = 500.5 -> 501; 1.001 x 499 = 499.499 -> 499.
    expect(computeFuelBaseCents(1001, 500)).toBe(501);
    expect(computeFuelBaseCents(1001, 499)).toBe(499);
    // Exact half at the milligallon step: 0.001 gal x 500c = 0.5 -> 1.
    expect(computeFuelBaseCents(1, 500)).toBe(1);
    expect(computeFuelBaseCents(1, 499)).toBe(0);
  });

  it("rejects gallons with 4+ decimal places instead of rounding them", () => {
    expect(hasAtMostThreeDecimals(2.6755)).toBe(false);
    expect(gallonsToMilli(2.6755)).toBeNull();
    expect(() => deriveFuelTotal(2.6755, 100)).toThrow(/at most 3 decimal places/);
    expect(hasAtMostThreeDecimals(2.675)).toBe(true);
    expect(gallonsToMilli(2.675)).toBe(2675);
    expect(gallonsToMilli(120.5)).toBe(120500);
  });

  it("composes base + adjustment into the derived total", () => {
    const derived = deriveFuelTotal(100, 350, 15000);
    expect(derived.baseCents).toBe(35000);
    expect(derived.totalCents).toBe(50000);
    expect(deriveFuelTotal(100, 350).totalCents).toBe(35000);
    // A discount (negative adjustment) composes the same way.
    expect(deriveFuelTotal(100, 350, -500).totalCents).toBe(34500);
  });

  it("pins the legacy backfill reason string the migration writes", () => {
    expect(LEGACY_FUEL_ADJUSTMENT_REASON).toBe("Legacy variance (pre-F-053)");
  });
});
