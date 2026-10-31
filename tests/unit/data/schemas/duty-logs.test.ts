import { describe, expect, it } from "vitest";
import { createDutyLogSchema, updateDutyLogSchema } from "@/data/schemas/duty-logs";

describe("createDutyLogSchema", () => {
  it("accepts a minimal valid duty log", () => {
    expect(
      createDutyLogSchema.safeParse({
        duty_status: "driving",
        started_at: "2026-11-01T13:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown duty status", () => {
    expect(
      createDutyLogSchema.safeParse({
        duty_status: "flying",
        started_at: "2026-11-01T13:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("rejects a negative odometer", () => {
    expect(
      createDutyLogSchema.safeParse({
        duty_status: "on_duty",
        started_at: "2026-11-01T13:00:00.000Z",
        odometer: -5,
      }).success,
    ).toBe(false);
  });

  it("rejects a missing started_at", () => {
    expect(createDutyLogSchema.safeParse({ duty_status: "driving" }).success).toBe(false);
  });
});

describe("updateDutyLogSchema", () => {
  it("accepts a partial update", () => {
    expect(updateDutyLogSchema.safeParse({ notes: "fuel stop" }).success).toBe(true);
  });
});
