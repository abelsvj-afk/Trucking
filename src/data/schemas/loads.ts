// Task 3.6 (TASKS.md). The first entity with a real cross-field business
// rule beyond simple type checks, per docs/design/data-model.md: delivery
// must not precede pickup, when both are set - and only when both are
// set, since a load can be saved incomplete (docs/user-stories.md's
// alternative workflow) and stays `draft` either way.

import { z } from "zod";

export const loadStatusSchema = z.enum(["draft", "confirmed", "completed"]);

const loadFieldsSchema = z.object({
  truck_id: z.string().uuid().nullable().optional(),
  driver_id: z.string().uuid().nullable().optional(),
  broker_id: z.string().uuid().nullable().optional(),
  customer_id: z.string().uuid().nullable().optional(),
  origin: z.string().min(1, "origin is required."),
  destination: z.string().min(1, "destination is required."),
  pickup_date: z.string().optional(),
  delivery_date: z.string().optional(),
  rate_cents: z.number().int().nonnegative("rate_cents must not be negative.").optional(),
  miles: z.number().int().nonnegative("miles must not be negative.").optional(),
  status: loadStatusSchema.optional(),
  notes: z.string().optional(),
});

function deliveryNotBeforePickup(data: { pickup_date?: string; delivery_date?: string }) {
  if (data.pickup_date && data.delivery_date) {
    return new Date(data.delivery_date) >= new Date(data.pickup_date);
  }
  return true;
}

const dateOrderRefinement = {
  message: "delivery_date must not be before pickup_date.",
  path: ["delivery_date"],
};

export const createLoadSchema = loadFieldsSchema.refine(deliveryNotBeforePickup, dateOrderRefinement);

export const updateLoadSchema = loadFieldsSchema
  .partial()
  .refine(deliveryNotBeforePickup, dateOrderRefinement);
