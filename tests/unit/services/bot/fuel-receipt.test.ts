import { describe, expect, it } from "vitest";
import { fuelFieldsFromReceipt, RECEIPT_ROUNDING_REASON } from "@/services/bot/fuel-receipt";
import { computeFuelBaseCents, gallonsToMilli } from "@/lib/fuel-math";

// The 00043 invariant, mirrored: total = round_half_up(gallons x price) + adjustment.
const invariantHolds = (f: ReturnType<typeof fuelFieldsFromReceipt>) =>
  f.total_cost_cents === computeFuelBaseCents(gallonsToMilli(f.gallons)!, f.price_per_gallon_cents) + f.adjustment_cents;

describe("fuelFieldsFromReceipt", () => {
  it("keeps the receipt total exactly and satisfies the derived-total invariant", () => {
    const f = fuelFieldsFromReceipt(10.5, 3500);
    expect(f.total_cost_cents).toBe(3500);
    expect(f.price_per_gallon_cents).toBe(333);
    expect(invariantHolds(f)).toBe(true);
    expect(f.adjustment_cents).toBe(3500 - computeFuelBaseCents(10500, 333));
    expect(f.adjustment_reason).toBe(RECEIPT_ROUNDING_REASON);
  });

  it("the Unit C tripwire: 2.675 gal for $2.68 is exactly 100c/gal, no adjustment", () => {
    const f = fuelFieldsFromReceipt(2.675, 268);
    expect(f).toEqual({
      gallons: 2.675,
      price_per_gallon_cents: 100,
      adjustment_cents: 0,
      adjustment_reason: null,
      total_cost_cents: 268,
    });
  });

  it("holds across a sweep of real-world receipts (never a row the database would reject)", () => {
    for (const gallons of [1, 3.333, 47.123, 99.999, 150.5, 212.007]) {
      for (const total of [1, 999, 15_999, 54_321, 89_995]) {
        const f = fuelFieldsFromReceipt(gallons, total);
        expect(f.total_cost_cents).toBe(total);
        expect(invariantHolds(f)).toBe(true);
        if (f.adjustment_cents !== 0) expect(f.adjustment_reason).toBeTruthy();
      }
    }
  });

  it("refuses gallons beyond 3 decimals or zero, rather than rounding them", () => {
    expect(() => fuelFieldsFromReceipt(10.1234, 3500)).toThrow(/3 decimal/);
    expect(() => fuelFieldsFromReceipt(0, 3500)).toThrow();
  });
});
