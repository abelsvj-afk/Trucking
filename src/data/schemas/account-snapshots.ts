import { z } from "zod";
import { moneyLaneSchema } from "./fund-entries";

export const createAccountSnapshotSchema = z.object({
  institution: z.string().min(1, "institution is required."),
  account_name: z.string().min(1, "account_name is required."),
  // Display-only last 4 (docs/schemas.md) - exactly 4 alphanumeric
  // characters, so a full account number can never be pasted into
  // this field by mistake.
  last4: z
    .string()
    .regex(/^[A-Za-z0-9]{4}$/, "last4 must be exactly the last 4 characters of the account number."),
  // May be negative: a credit card's balance is money owed.
  balance_cents: z.number().int("balance_cents must be a whole number of cents."),
  lane: moneyLaneSchema,
  as_of_date: z.string().min(1, "as_of_date is required."),
  note: z.string().nullable().optional(),
});

export const updateAccountSnapshotSchema = createAccountSnapshotSchema.partial();
