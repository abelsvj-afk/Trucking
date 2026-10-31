import { describe, expect, it } from "vitest";
import { updateFundSettingsSchema } from "@/data/schemas/fund-settings";

describe("updateFundSettingsSchema", () => {
  it("accepts the rule off with no values (the default state)", () => {
    expect(updateFundSettingsSchema.safeParse({ sweep_mode: "off" }).success).toBe(true);
  });

  it("requires the percent when the mode is percent", () => {
    expect(updateFundSettingsSchema.safeParse({ sweep_mode: "percent" }).success).toBe(false);
    expect(
      updateFundSettingsSchema.safeParse({ sweep_mode: "percent", sweep_percent: 25 }).success,
    ).toBe(true);
  });

  it("requires a positive flat amount when the mode is flat", () => {
    expect(updateFundSettingsSchema.safeParse({ sweep_mode: "flat" }).success).toBe(false);
    expect(
      updateFundSettingsSchema.safeParse({ sweep_mode: "flat", sweep_flat_cents: 0 }).success,
    ).toBe(false);
    expect(
      updateFundSettingsSchema.safeParse({ sweep_mode: "flat", sweep_flat_cents: 20_000 }).success,
    ).toBe(true);
  });

  it("rejects a percent outside 1-100", () => {
    expect(
      updateFundSettingsSchema.safeParse({ sweep_mode: "percent", sweep_percent: 0 }).success,
    ).toBe(false);
    expect(
      updateFundSettingsSchema.safeParse({ sweep_mode: "percent", sweep_percent: 101 }).success,
    ).toBe(false);
  });
});
