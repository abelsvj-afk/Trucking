import { describe, expect, it } from "vitest";
import { createFuelPurchaseSchema, updateFuelPurchaseSchema } from "@/data/schemas/fuel-purchases";

const VALID = {
  truck_id: "11111111-1111-4111-8111-111111111111",
  gallons: 120.5,
  price_per_gallon_cents: 385,
  total_cost_cents: 46393,
  purchased_at: "2026-08-21",
};

describe("createFuelPurchaseSchema", () => {
  it("accepts a minimal valid fuel purchase", () => {
    expect(createFuelPurchaseSchema.safeParse(VALID).success).toBe(true);
  });

  it("rejects a missing truck_id", () => {
    const { truck_id: _truck_id, ...rest } = VALID;
    expect(createFuelPurchaseSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects zero or negative gallons", () => {
    expect(createFuelPurchaseSchema.safeParse({ ...VALID, gallons: 0 }).success).toBe(false);
    expect(createFuelPurchaseSchema.safeParse({ ...VALID, gallons: -5 }).success).toBe(false);
  });

  it("rejects a negative price_per_gallon_cents", () => {
    expect(
      createFuelPurchaseSchema.safeParse({ ...VALID, price_per_gallon_cents: -1 }).success,
    ).toBe(false);
  });

  it("rejects a negative total_cost_cents", () => {
    expect(createFuelPurchaseSchema.safeParse({ ...VALID, total_cost_cents: -1 }).success).toBe(
      false,
    );
  });

  it("rejects a missing purchased_at", () => {
    const { purchased_at: _purchased_at, ...rest } = VALID;
    expect(createFuelPurchaseSchema.safeParse(rest).success).toBe(false);
  });

  it("accepts an optional location", () => {
    expect(createFuelPurchaseSchema.safeParse({ ...VALID, location: "Love's #123" }).success).toBe(
      true,
    );
  });
});

describe("updateFuelPurchaseSchema", () => {
  it("allows a partial update", () => {
    expect(updateFuelPurchaseSchema.safeParse({ gallons: 50 }).success).toBe(true);
  });

  it("still rejects non-positive gallons on a partial update", () => {
    expect(updateFuelPurchaseSchema.safeParse({ gallons: 0 }).success).toBe(false);
  });
});
