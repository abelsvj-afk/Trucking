import { describe, expect, it } from "vitest";
import { createFundEntrySchema } from "@/data/schemas/fund-entries";

const valid = {
  fund_key: "truck_fund",
  kind: "deposit",
  amount_cents: 25_000,
  entry_date: "2026-10-31",
  lane: "business",
  source: "manual",
};

describe("createFundEntrySchema", () => {
  it("accepts a valid entry", () => {
    expect(createFundEntrySchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a zero or negative amount (the sign comes from kind)", () => {
    expect(createFundEntrySchema.safeParse({ ...valid, amount_cents: 0 }).success).toBe(false);
    expect(createFundEntrySchema.safeParse({ ...valid, amount_cents: -500 }).success).toBe(false);
  });

  it("rejects an unknown fund or lane", () => {
    expect(createFundEntrySchema.safeParse({ ...valid, fund_key: "vacation" }).success).toBe(false);
    expect(createFundEntrySchema.safeParse({ ...valid, lane: "mixed" }).success).toBe(false);
  });
});
