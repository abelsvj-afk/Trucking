import { z } from "zod";

export const fundKeySchema = z.enum(["truck_fund", "business_credit", "emergency_fund"]);
export const fundEntryKindSchema = z.enum(["deposit", "withdrawal"]);
export const moneyLaneSchema = z.enum(["business", "personal"]);
export const fundEntrySourceSchema = z.enum(["manual", "sweep"]);

export const createFundEntrySchema = z.object({
  fund_key: fundKeySchema,
  kind: fundEntryKindSchema,
  // Positive by design (docs/schemas.md): the sign comes from `kind`,
  // so a "negative deposit" can never be recorded by accident.
  amount_cents: z.number().int().positive("amount_cents must be greater than zero."),
  entry_date: z.string().min(1, "entry_date is required."),
  lane: moneyLaneSchema,
  // Sent explicitly by every caller (the form sends "manual"; the
  // suggestion card's Record-it sends "sweep") - no silent default,
  // so an entry's provenance is always a deliberate choice.
  source: fundEntrySourceSchema,
  note: z.string().nullable().optional(),
  load_id: z.string().uuid().nullable().optional(),
});

export const updateFundEntrySchema = createFundEntrySchema.partial();
