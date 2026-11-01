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

  // Smart Path v1 truck profile (docs/design/driver-mvp.md §8.2).
  it("accepts a full truck profile", () => {
    const result = createTruckSchema.safeParse({
      unit_number: "Truck #1",
      height_in: 162,
      length_in: 840,
      weight_lbs: 80000,
      governed_speed_mph: 65,
      tank_capacity_gallons: 120,
      avg_mpg: 6.8,
      appliances: ["fridge", "microwave", "inverter"],
      appliance_notes: "2000W inverter",
    });
    expect(result.success).toBe(true);
  });

  it("rejects 'none' combined with other appliances", () => {
    const result = createTruckSchema.safeParse({
      unit_number: "Truck #1",
      appliances: ["none", "fridge"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown appliance and implausible profile numbers", () => {
    expect(
      createTruckSchema.safeParse({ unit_number: "Truck #1", appliances: ["jacuzzi"] }).success,
    ).toBe(false);
    expect(
      createTruckSchema.safeParse({ unit_number: "Truck #1", avg_mpg: 30 }).success,
    ).toBe(false);
    expect(
      createTruckSchema.safeParse({ unit_number: "Truck #1", governed_speed_mph: 10 }).success,
    ).toBe(false);
    expect(
      createTruckSchema.safeParse({ unit_number: "Truck #1", height_in: -1 }).success,
    ).toBe(false);
  });

  it("update schema accepts a partial profile", () => {
    const result = updateTruckSchema.safeParse({ appliances: ["cooler"] });
    expect(result.success).toBe(true);
  });
});

describe("updateTruckSchema", () => {
  it("allows a partial update with no required fields", () => {
    const result = updateTruckSchema.safeParse({ status: "maintenance" });
    expect(result.success).toBe(true);
  });
});
