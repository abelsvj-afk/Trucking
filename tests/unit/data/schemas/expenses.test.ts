import { describe, expect, it } from "vitest";
import { createExpenseSchema, updateExpenseSchema } from "@/data/schemas/expenses";

describe("createExpenseSchema", () => {
  it("accepts a minimal valid expense", () => {
    const result = createExpenseSchema.safeParse({
      category: "repairs",
      amount_cents: 5000,
      expense_date: "2026-08-21",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing category", () => {
    expect(
      createExpenseSchema.safeParse({ amount_cents: 5000, expense_date: "2026-08-21" }).success,
    ).toBe(false);
  });

  it("rejects an invalid category", () => {
    expect(
      createExpenseSchema.safeParse({
        category: "fuel",
        amount_cents: 5000,
        expense_date: "2026-08-21",
      }).success,
    ).toBe(false);
  });

  it("rejects a missing expense_date", () => {
    expect(createExpenseSchema.safeParse({ category: "other", amount_cents: 5000 }).success).toBe(
      false,
    );
  });

  it("rejects a negative amount_cents", () => {
    const result = createExpenseSchema.safeParse({
      category: "other",
      amount_cents: -100,
      expense_date: "2026-08-21",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer amount_cents", () => {
    const result = createExpenseSchema.safeParse({
      category: "other",
      amount_cents: 50.5,
      expense_date: "2026-08-21",
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional truck_id/load_id/driver_id/description", () => {
    const result = createExpenseSchema.safeParse({
      category: "repairs",
      amount_cents: 5000,
      expense_date: "2026-08-21",
      truck_id: "11111111-1111-4111-8111-111111111111",
      load_id: null,
      driver_id: null,
      description: "Brake pads",
    });
    expect(result.success).toBe(true);
  });
});

describe("updateExpenseSchema", () => {
  it("allows a partial update", () => {
    expect(updateExpenseSchema.safeParse({ amount_cents: 6000 }).success).toBe(true);
  });

  it("still rejects a negative amount_cents on a partial update", () => {
    expect(updateExpenseSchema.safeParse({ amount_cents: -1 }).success).toBe(false);
  });
});
