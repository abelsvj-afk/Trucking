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
