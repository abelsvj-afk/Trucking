// GAP-13 (Fresh-Eyes Register 2026-11-02): recurring obligation rows.

import { z } from "zod";

export const obligationCadenceSchema = z.enum([
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "annual",
]);

const obligationFieldsSchema = z.object({
  name: z.string().min(1, "name is required."),
  amount_cents: z.number().int().nonnegative("amount_cents must not be negative."),
  cadence: obligationCadenceSchema,
  day_of_month: z.number().int().min(1).max(31).nullable().optional(),
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  anchor_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "anchor_date must be YYYY-MM-DD.")
    .nullable()
    .optional(),
  active: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});

export const createRecurringObligationSchema = obligationFieldsSchema;
export const updateRecurringObligationSchema = obligationFieldsSchema.partial();
