import { z } from "zod";

/**
 * Business Credit (migration 00087; docs/design/business-credit.md).
 * The states the email watch and Abel's update tool may write. The
 * watch itself only ever touches payment_state / next_due_date /
 * amount_due_cents, and only from what the mail states.
 */
export const businessCreditPaymentStates = [
  "none",
  "invoice_open",
  "due_soon",
  "paid",
  "missed",
] as const;

export const businessCreditPaymentStateSchema = z.enum(
  businessCreditPaymentStates,
);

export const updateBusinessCreditAccountSchema = z
  .object({
    vendor_key: z
      .string()
      .min(1, "vendor_key is required (quill, uline, ecredable, nav, bluevine, dun-and-bradstreet)."),
    status: z.string().min(1).optional(),
    next_action: z.string().nullable().optional(),
    payment_state: businessCreditPaymentStateSchema.optional(),
    next_due_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "next_due_date must be YYYY-MM-DD.")
      .nullable()
      .optional(),
    amount_due_cents: z.number().int().nonnegative().nullable().optional(),
    notes: z.string().nullable().optional(),
    reports_to: z.array(z.string().min(1)).optional(),
  })
  .refine(
    (v) =>
      v.status !== undefined ||
      v.next_action !== undefined ||
      v.payment_state !== undefined ||
      v.next_due_date !== undefined ||
      v.amount_due_cents !== undefined ||
      v.notes !== undefined ||
      v.reports_to !== undefined,
    { message: "Nothing to change — name at least one field to update." },
  );
