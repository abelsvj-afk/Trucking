import { describe, expect, it } from "vitest";
import { createTruckSchema, updateTruckSchema } from "@/data/schemas/trucks";

describe("createTruckSchema", () => {
  it("accepts a minimal valid truck", () => {
    const result = createTruckSchema.safeParse({ unit_number: "Truck #1" });
    expect(result.success).toBe(true);
  });

  it("rejects a missing unit_number", () => {
    const result = createTruckSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects a negative current_mileage", () => {
    const result = createTruckSchema.safeParse({
      unit_number: "Truck #1",
      current_mileage: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid status", () => {
    const result = createTruckSchema.safeParse({
      unit_number: "Truck #1",
      status: "on-fire",
    });
    expect(result.success).toBe(false);
  });
});

describe("updateTruckSchema", () => {
  it("allows a partial update with no required fields", () => {
    const result = updateTruckSchema.safeParse({ status: "maintenance" });
    expect(result.success).toBe(true);
  });
});
