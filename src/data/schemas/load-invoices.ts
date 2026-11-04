// GAP-12 (Fresh-Eyes Register 2026-11-02): receivable rows.

import { z } from "zod";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD.");

const loadInvoiceFieldsSchema = z.object({
  load_id: z.string().uuid(),
  broker_id: z.string().uuid().nullable().optional(),
  invoice_date: dateString,
  due_date: dateString,
  amount_cents: z.number().int().nonnegative("amount_cents must not be negative."),
  paid_amount_cents: z.number().int().nonnegative().optional(),
  paid_on: dateString.nullable().optional(),
  factored: z.boolean().optional(),
  factor_fee_cents: z.number().int().nonnegative().nullable().optional(),
  factor_reserve_cents: z.number().int().nonnegative().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const createLoadInvoiceSchema = loadInvoiceFieldsSchema;
export const updateLoadInvoiceSchema = loadInvoiceFieldsSchema.partial();
