import { z } from "zod";

export const expenseCategorySchema = z.enum(["insurance", "permits", "repairs", "other"]);

export const createExpenseSchema = z.object({
  // GAP-07: a client-generated id lets an offline-queued create be
  // replayed safely — a retry finds the row already there instead
  // of double-booking the expense.
  id: z.string().uuid().optional(),
  category: expenseCategorySchema,
  // Migration 00085 (expense buckets spec 2026-11-09): which kind of
  // money this is. Optional so older callers keep working; the
  // database default is 'business'.
  bucket: z.enum(["business", "pay_deduction"]).optional(),
  amount_cents: z.number().int().nonnegative("amount_cents must not be negative."),
  expense_date: z.string().min(1, "expense_date is required."),
  truck_id: z.string().uuid().nullable().optional(),
  load_id: z.string().uuid().nullable().optional(),
  driver_id: z.string().uuid().nullable().optional(),
  description: z.string().optional(),
});

export const updateExpenseSchema = createExpenseSchema.partial();
