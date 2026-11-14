import { z } from "zod";

// Migration 00063. mile_basis / worker_type / fuel_paid_by: null = visibly UNSET.
const basis = z.enum(["loaded", "all", "practical"]);
const worker = z.enum(["w2", "1099"]);
const fuel = z.enum(["employer", "driver"]);
// Migration 00074.
const bps = z.number().int().min(0).max(10_000, "percent must be 0 to 100.");
const weekday = z.number().int().min(0).max(6);

export const createPayProfileSchema = z.object({
  employer_name: z.string().trim().min(1, "employer_name is required."),
  rate_cents_per_mile: z.number().int().nonnegative("rate must not be negative."),
  mile_basis: basis.nullable().optional(),
  worker_type: worker.nullable().optional(),
  fuel_paid_by: fuel.nullable().optional(),
  percent_of_load_bps: bps.nullable().optional(),
  /** Migration 00094: tax set-aside percent in basis points; null = the 25% default (labelled as such in the UI). */
  tax_set_aside_bps: bps.nullable().optional(),
  pay_week_ends_on: weekday.nullable().optional(),
  statement_weekday: weekday.nullable().optional(),
  payday_weekday: weekday.nullable().optional(),
  effective_from: z.string().optional(),
  notes: z.string().optional(),
});

export const updatePayProfileSchema = z.object({
  employer_name: z.string().trim().min(1).optional(),
  rate_cents_per_mile: z.number().int().nonnegative().optional(),
  mile_basis: basis.nullable().optional(),
  worker_type: worker.nullable().optional(),
  fuel_paid_by: fuel.nullable().optional(),
  percent_of_load_bps: bps.nullable().optional(),
  /** Migration 00094: tax set-aside percent in basis points; null = the 25% default. */
  tax_set_aside_bps: bps.nullable().optional(),
  pay_week_ends_on: weekday.nullable().optional(),
  statement_weekday: weekday.nullable().optional(),
  payday_weekday: weekday.nullable().optional(),
  effective_to: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
