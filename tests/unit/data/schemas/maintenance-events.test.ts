import { describe, expect, it } from "vitest";
import {
  createMaintenanceEventSchema,
  updateMaintenanceEventSchema,
} from "@/data/schemas/maintenance-events";

const VALID = {
  truck_id: "11111111-1111-4111-8111-111111111111",
  description: "Oil change",
  service_date: "2026-08-21",
};

describe("createMaintenanceEventSchema", () => {
  it("accepts a minimal valid maintenance event (no cost/mileage)", () => {
    expect(createMaintenanceEventSchema.safeParse(VALID).success).toBe(true);
  });

  it("rejects a missing truck_id", () => {
    const { truck_id: _truck_id, ...rest } = VALID;
    expect(createMaintenanceEventSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a missing description", () => {
    const { description: _description, ...rest } = VALID;
    expect(createMaintenanceEventSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a missing service_date", () => {
    const { service_date: _service_date, ...rest } = VALID;
    expect(createMaintenanceEventSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a negative cost_cents", () => {
    expect(createMaintenanceEventSchema.safeParse({ ...VALID, cost_cents: -1 }).success).toBe(
      false,
    );
  });

  it("accepts a null cost_cents and null mileage_at_service", () => {
    expect(
      createMaintenanceEventSchema.safeParse({
        ...VALID,
        cost_cents: null,
        mileage_at_service: null,
      }).success,
    ).toBe(true);
  });

  it("rejects a negative mileage_at_service", () => {
    expect(
      createMaintenanceEventSchema.safeParse({ ...VALID, mileage_at_service: -1 }).success,
    ).toBe(false);
  });
});

describe("updateMaintenanceEventSchema", () => {
  it("allows a partial update", () => {
    expect(updateMaintenanceEventSchema.safeParse({ description: "Brake service" }).success).toBe(
      true,
    );
  });

  it("still rejects a negative cost_cents on a partial update", () => {
    expect(updateMaintenanceEventSchema.safeParse({ cost_cents: -1 }).success).toBe(false);
  });
});
