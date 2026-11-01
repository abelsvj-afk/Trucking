import { describe, expect, it } from "vitest";
import { createAccountSnapshotSchema } from "@/data/schemas/account-snapshots";

const valid = {
  institution: "Chase",
  account_name: "Business checking",
  last4: "4821",
  balance_cents: 125_000,
  lane: "business",
  as_of_date: "2026-10-31",
};

describe("createAccountSnapshotSchema", () => {
  it("accepts a valid snapshot, including a negative (owed) balance", () => {
    expect(createAccountSnapshotSchema.safeParse(valid).success).toBe(true);
    expect(
      createAccountSnapshotSchema.safeParse({ ...valid, balance_cents: -45_000 }).success,
    ).toBe(true);
  });

  it("rejects a last4 that is not exactly 4 characters (a full number can never fit)", () => {
    expect(createAccountSnapshotSchema.safeParse({ ...valid, last4: "482" }).success).toBe(false);
    expect(
      createAccountSnapshotSchema.safeParse({ ...valid, last4: "1234567890124821" }).success,
    ).toBe(false);
  });

  it("rejects a fractional-cent balance", () => {
    expect(
      createAccountSnapshotSchema.safeParse({ ...valid, balance_cents: 100.5 }).success,
    ).toBe(false);
  });
});
