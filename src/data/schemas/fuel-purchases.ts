import { z } from "zod";

// Reliability Unit C (design C.4, ruling D-04): the total is DERIVED -
// gallons x price per gallon, plus an explicit adjustment - never a
// free-typed third number. This schema carries the SHAPE; the record
// rules live in the write path (services/api/fuel-write.ts), where
// they surface as field-level 422s per C.7.5/5b on both POST and
// PATCH: gallons precision (at most 3 decimals), a nonzero adjustment
// requires a reason, the derived total cannot be negative, and a
// client-supplied total_cost_cents is accepted only as the derived
// echo. total_cost_cents is therefore optional here - the write path
// always stores the derived value - and the database enforces the
// same invariant for every writer (migration 00043):
// total_cost_cents = round(gallons * price) + adjustment_cents, with
// the adjustment-reason CHECK beside it.
export const createFuelPurchaseSchema = z.object({
  // GAP-07: client-generated id for safe offline replay (see expenses).
  id: z.string().uuid().optional(),
  truck_id: z.string().uuid(),
  location: z.string().optional(),
  // GAP-15: purchase state (IFTA) — two-letter, upper-cased by callers.
  state: z.string().length(2).optional(),
  gallons: z.number().positive("gallons must be positive."),
  price_per_gallon_cents: z.number().int().nonnegative("price_per_gallon_cents must not be negative."),
  total_cost_cents: z.number().int().nonnegative("total_cost_cents must not be negative.").optional(),
  adjustment_cents: z.number().int("adjustment_cents must be a whole number of cents.").optional(),
  adjustment_reason: z.string().nullable().optional(),
  purchased_at: z.string().min(1, "purchased_at is required."),
});

export const updateFuelPurchaseSchema = createFuelPurchaseSchema.partial();
