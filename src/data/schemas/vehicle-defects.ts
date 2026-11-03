// Vehicle defects (migration 00043, Image Intelligence §5.5):
// a tracked observed problem on exactly one vehicle - the third
// maintenance noun beside events (work done) and schedules
// (future work). Same exactly-one-vehicle rule as schedules and
// pre-trip inspections (00010's constraint shape).

import { z } from "zod";

export const vehicleDefectSourceSchema = z.enum(["pretrip", "photo", "conversation"]);
export const vehicleDefectStatusSchema = z.enum(["open", "acknowledged", "closed", "dismissed"]);

const vehicleDefectFieldsSchema = z.object({
  truck_id: z.string().uuid().nullable().optional(),
  trailer_id: z.string().uuid().nullable().optional(),
  description: z.string().min(1, "description is required."),
  source: vehicleDefectSourceSchema,
  source_inspection_id: z.string().uuid().nullable().optional(),
  source_document_id: z.string().uuid().nullable().optional(),
  status: vehicleDefectStatusSchema.optional(),
  maintenance_event_id: z.string().uuid().nullable().optional(),
});

function exactlyOneVehicle(data: { truck_id?: string | null; trailer_id?: string | null }) {
  return Boolean(data.truck_id) !== Boolean(data.trailer_id);
}

export const createVehicleDefectSchema = vehicleDefectFieldsSchema.refine(exactlyOneVehicle, {
  message: "exactly one of truck_id or trailer_id is required.",
  path: ["truck_id"],
});

export const updateVehicleDefectSchema = vehicleDefectFieldsSchema
  .partial()
  .refine(
    (data) =>
      data.truck_id === undefined && data.trailer_id === undefined ? true : exactlyOneVehicle(data),
    { message: "exactly one of truck_id or trailer_id is required.", path: ["truck_id"] },
  );
