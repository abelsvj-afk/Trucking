import { z } from "zod";

export const sweepModeSchema = z.enum(["off", "percent", "flat"]);
export const truckPriceBandSchema = z.enum(["budget", "mid", "upper"]);

// The sweep rule's value must exist for the mode that uses it
// (docs/design/driver-mvp.md §9.1) - a "percent" rule with no percent
// would silently compute nothing, so it's rejected here instead.
export const updateFundSettingsSchema = z
  .object({
    sweep_mode: sweepModeSchema,
    sweep_percent: z.number().int().min(1).max(100).nullable().optional(),
    sweep_flat_cents: z.number().int().positive().nullable().optional(),
    target_band: truckPriceBandSchema.nullable().optional(),
    target_cents: z.number().int().positive().nullable().optional(),
  })
  .refine((value) => value.sweep_mode !== "percent" || value.sweep_percent != null, {
    message: "sweep_percent is required when sweep_mode is 'percent'.",
    path: ["sweep_percent"],
  })
  .refine((value) => value.sweep_mode !== "flat" || value.sweep_flat_cents != null, {
    message: "sweep_flat_cents is required when sweep_mode is 'flat'.",
    path: ["sweep_flat_cents"],
  });
