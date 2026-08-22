// Task 3.15 (TASKS.md), per docs/schemas.md/docs/design/data-model.md:
// exactly one of truck_id/trailer_id.

import { z } from "zod";

const pretripInspectionFieldsSchema = z.object({
  truck_id: z.string().uuid().nullable().optional(),
  trailer_id: z.string().uuid().nullable().optional(),
  driver_id: z.string().uuid().nullable().optional(),
  inspected_at: z.string().min(1, "inspected_at is required."),
  passed: z.boolean(),
  defects_found: z.string().nullable().optional(),
});

function exactlyOneVehicle(data: { truck_id?: string | null; trailer_id?: string | null }) {
  return Boolean(data.truck_id) !== Boolean(data.trailer_id);
}

export const createPretripInspectionSchema = pretripInspectionFieldsSchema.refine(exactlyOneVehicle, {
  message: "exactly one of truck_id or trailer_id is required.",
  path: ["truck_id"],
});

export const updatePretripInspectionSchema = pretripInspectionFieldsSchema
  .partial()
  .refine(
    (data) =>
      data.truck_id === undefined && data.trailer_id === undefined ? true : exactlyOneVehicle(data),
    { message: "exactly one of truck_id or trailer_id is required.", path: ["truck_id"] },
  );
