import { describe, expect, it } from "vitest";
import { createDriverSchema } from "@/data/schemas/drivers";

describe("createDriverSchema", () => {
  it("accepts a minimal valid driver", () => {
    expect(createDriverSchema.safeParse({ name: "Jane Doe" }).success).toBe(true);
  });

  it("rejects a missing name", () => {
    expect(createDriverSchema.safeParse({}).success).toBe(false);
  });

  it("accepts an explicit null assigned_truck_id (unassigned)", () => {
    expect(
      createDriverSchema.safeParse({ name: "Jane Doe", assigned_truck_id: null }).success,
    ).toBe(true);
  });

  it("rejects a non-UUID assigned_truck_id", () => {
    expect(
      createDriverSchema.safeParse({ name: "Jane Doe", assigned_truck_id: "not-a-uuid" }).success,
    ).toBe(false);
  });
});
