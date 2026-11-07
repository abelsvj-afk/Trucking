import { z } from "zod";

// Cash advances (docs/design/employer-pay-profile.md section 9).
// amount_cents is positive by design: an advance is money taken out of a
// pay period, so the sign comes from what it is - a "negative advance"
// can never be recorded by accident.
export const createCashAdvanceSchema = z.object({
  amount_cents: z.number().int().positive("amount_cents must be greater than zero."),
  advance_date: z.string().min(1, "advance_date is required."),
  driver_id: z.string().uuid().nullable().optional(),
  note: z.string().nullable().optional(),
});

export const updateCashAdvanceSchema = createCashAdvanceSchema.partial();
