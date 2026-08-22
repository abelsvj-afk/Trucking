// Tasks 3.13 (TASKS.md), per docs/schemas.md/docs/design/data-model.md's
// business rules: exactly one of truck_id/trailer_id, and at least one
// of interval_miles/interval_days (a schedule with neither could never
// become due). Mirrors loads.ts's cross-field .refine() pattern.

import { z } from "zod";

export const maintenanceScheduleStatusSchema = z.enum(["active", "paused"]);

const maintenanceScheduleFieldsSchema = z.object({
  truck_id: z.string().uuid().nullable().optional(),
  trailer_id: z.string().uuid().nullable().optional(),
  description: z.string().min(1, "description is required."),
  interval_miles: z.number().int().positive("interval_miles must be positive.").nullable().optional(),
  interval_days: z.number().int().positive("interval_days must be positive.").nullable().optional(),
  last_done_date: z.string().nullable().optional(),
  last_done_mileage: z
    .number()
    .int()
    .nonnegative("last_done_mileage must not be negative.")
    .nullable()
    .optional(),
  status: maintenanceScheduleStatusSchema.optional(),
});

function exactlyOneVehicle(data: { truck_id?: string | null; trailer_id?: string | null }) {
  return Boolean(data.truck_id) !== Boolean(data.trailer_id);
}

function hasAnInterval(data: { interval_miles?: number | null; interval_days?: number | null }) {
  return Boolean(data.interval_miles) || Boolean(data.interval_days);
}

export const createMaintenanceScheduleSchema = maintenanceScheduleFieldsSchema
  .refine(exactlyOneVehicle, {
    message: "exactly one of truck_id or trailer_id is required.",
    path: ["truck_id"],
  })
  .refine(hasAnInterval, {
    message: "at least one of interval_miles or interval_days is required.",
    path: ["interval_miles"],
  });

// A partial update still can't leave the row without a vehicle or an
// interval - but a partial update also doesn't necessarily send every
// field, so both refinements only apply when the field(s) they check are
// actually present in this specific request. This matches the intent
// (never let a write leave the row invalid) without rejecting an
// unrelated field update that doesn't touch vehicle/interval at all.
export const updateMaintenanceScheduleSchema = maintenanceScheduleFieldsSchema
  .partial()
  .refine(
    (data) =>
      data.truck_id === undefined && data.trailer_id === undefined ? true : exactlyOneVehicle(data),
    { message: "exactly one of truck_id or trailer_id is required.", path: ["truck_id"] },
  )
  .refine(
    (data) =>
      data.interval_miles === undefined && data.interval_days === undefined
        ? true
        : hasAnInterval(data),
    { message: "at least one of interval_miles or interval_days is required.", path: ["interval_miles"] },
  );
