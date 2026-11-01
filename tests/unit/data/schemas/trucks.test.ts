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

// UI/UX upgrade (migration 00027): truck type + photo pointer.
describe("createTruckSchema (UI/UX upgrade fields)", () => {
  it("accepts a picklist truck_type and a photo pointer", () => {
    const result = createTruckSchema.safeParse({
      unit_number: "Truck #1",
      truck_type: "sleeper_semi",
      photo_document_id: "00000000-0000-4000-8000-000000000001",
    });
    expect(result.success).toBe(true);
  });

  it("accepts free-text truck_type (the Other case)", () => {
    expect(
      createTruckSchema.safeParse({ unit_number: "Truck #1", truck_type: "Yard dog" }).success,
    ).toBe(true);
  });

  it("accepts an explicit null photo_document_id (photo removed)", () => {
    expect(
      createTruckSchema.safeParse({ unit_number: "Truck #1", photo_document_id: null }).success,
    ).toBe(true);
  });

  it("rejects an empty truck_type and an over-long one", () => {
    expect(createTruckSchema.safeParse({ unit_number: "Truck #1", truck_type: "" }).success).toBe(
      false,
    );
    expect(
      createTruckSchema.safeParse({ unit_number: "Truck #1", truck_type: "x".repeat(61) }).success,
    ).toBe(false);
  });

  it("rejects a non-UUID photo_document_id", () => {
    expect(
      createTruckSchema.safeParse({ unit_number: "Truck #1", photo_document_id: "doc-1" }).success,
    ).toBe(false);
  });

  it("update schema accepts just the new fields", () => {
    expect(updateTruckSchema.safeParse({ truck_type: "hotshot" }).success).toBe(true);
    expect(updateTruckSchema.safeParse({ photo_document_id: null }).success).toBe(true);
  });
});
