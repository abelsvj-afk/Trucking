import { z } from "zod";

// Migration 00063. mile_basis / worker_type / fuel_paid_by: null = visibly UNSET.
const basis = z.enum(["loaded", "all", "practical"]);
const worker = z.enum(["w2", "1099"]);
const fuel = z.enum(["employer", "driver"]);

export const createPayProfileSchema = z.object({
  employer_name: z.string().trim().min(1, "employer_name is required."),
  rate_cents_per_mile: z.number().int().nonnegative("rate must not be negative."),
  mile_basis: basis.nullable().optional(),
  worker_type: worker.nullable().optional(),
  fuel_paid_by: fuel.nullable().optional(),
  effective_from: z.string().optional(),
  notes: z.string().optional(),
});

export const updatePayProfileSchema = z.object({
  employer_name: z.string().trim().min(1).optional(),
  rate_cents_per_mile: z.number().int().nonnegative().optional(),
  mile_basis: basis.nullable().optional(),
  worker_type: worker.nullable().optional(),
  fuel_paid_by: fuel.nullable().optional(),
  effective_to: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
