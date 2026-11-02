// Smart Path v1 (docs/design/driver-mvp.md §8.3). Validation for the
// route-check endpoint - the enforcement point for the contract in
// docs/api-contracts.md, checked in validateBody() before any
// provider or database call happens.

import { z } from "zod";

const isoTimestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "must be an ISO timestamp.");

export const timeWindowSchema = z
  .object({
    start: isoTimestamp,
    end: isoTimestamp,
  })
  .refine((window) => Date.parse(window.start) < Date.parse(window.end), {
    message: "window start must be before window end.",
  });

export const routeCheckRequestSchema = z.object({
  load_id: z.string().uuid("load_id must be a load id."),
  depart_at: isoTimestamp,
  // Piece 1 (P1-7): where the run actually starts, before the pickup.
  // All optional - absence is today's pickup-only behavior exactly.
  // start_point (from the one-shot "where I am" fix) wins over
  // start_location (geocoded server-side) when both are given.
  start_location: z.string().trim().min(3).max(200).optional(),
  start_point: z
    .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
    .optional(),
  start_at: isoTimestamp.optional(),
  // Piece 1 (P1-9): per-request life preferences - sleep window and
  // a workout break the planner should try to fit. Absent = today's
  // behavior with today's defaults.
  life: z
    .object({
      sleep_start_hour: z.number().int().min(0).max(23).optional(),
      sleep_end_hour: z.number().int().min(0).max(23).optional(),
      workout: z
        .object({
          want: z.boolean(),
          minutes: z.number().int().min(30).max(180).default(60),
          setting: z.enum(["gym_preferred", "any_safe_stop"]).default("gym_preferred"),
        })
        .optional(),
    })
    .optional(),
  pickup_window: timeWindowSchema.optional(),
  delivery_window: timeWindowSchema.optional(),
  food_mode: z.enum(["grocery", "fast_food"]).default("grocery"),
  gallons_to_buy: z
    .number()
    .positive("gallons_to_buy must be positive.")
    .max(300, "gallons_to_buy is larger than any truck tank.")
    .optional(),
});

export type RouteCheckRequest = z.infer<typeof routeCheckRequestSchema>;
