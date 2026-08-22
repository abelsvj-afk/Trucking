// Task 3.14 (TASKS.md), per docs/schemas.md/docs/design/data-model.md:
// exactly one of truck_id/trailer_id.

import { z } from "zod";

const equipmentChecklistItemFieldsSchema = z.object({
  truck_id: z.string().uuid().nullable().optional(),
  trailer_id: z.string().uuid().nullable().optional(),
  item_name: z.string().min(1, "item_name is required."),
  quantity_on_hand: z
    .number()
    .int()
    .nonnegative("quantity_on_hand must not be negative.")
    .nullable()
    .optional(),
  last_checked_date: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

function exactlyOneVehicle(data: { truck_id?: string | null; trailer_id?: string | null }) {
  return Boolean(data.truck_id) !== Boolean(data.trailer_id);
}

export const createEquipmentChecklistItemSchema = equipmentChecklistItemFieldsSchema.refine(
  exactlyOneVehicle,
  { message: "exactly one of truck_id or trailer_id is required.", path: ["truck_id"] },
);

export const updateEquipmentChecklistItemSchema = equipmentChecklistItemFieldsSchema
  .partial()
  .refine(
    (data) =>
      data.truck_id === undefined && data.trailer_id === undefined ? true : exactlyOneVehicle(data),
    { message: "exactly one of truck_id or trailer_id is required.", path: ["truck_id"] },
  );
