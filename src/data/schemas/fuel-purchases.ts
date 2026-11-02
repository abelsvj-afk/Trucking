import { z } from "zod";

export const createFuelPurchaseSchema = z.object({
  // GAP-07: client-generated id for safe offline replay (see expenses).
  id: z.string().uuid().optional(),
  truck_id: z.string().uuid(),
  location: z.string().optional(),
  // GAP-15: purchase state (IFTA) — two-letter, upper-cased by callers.
  state: z.string().length(2).optional(),
  gallons: z.number().positive("gallons must be positive."),
  price_per_gallon_cents: z.number().int().nonnegative("price_per_gallon_cents must not be negative."),
  total_cost_cents: z.number().int().nonnegative("total_cost_cents must not be negative."),
  purchased_at: z.string().min(1, "purchased_at is required."),
});

export const updateFuelPurchaseSchema = createFuelPurchaseSchema.partial();
