import { z } from "zod";

export const trailerStatusSchema = z.enum(["active", "maintenance", "inactive"]);

export const createTrailerSchema = z.object({
  unit_number: z.string().min(1, "unit_number is required."),
  vin: z.string().optional(),
  trailer_type: z.string().optional(),
  status: trailerStatusSchema.optional(),
  // The documents row holding this trailer's photo (migration 00027).
  photo_document_id: z.string().uuid().nullable().optional(),
});

export const updateTrailerSchema = createTrailerSchema.partial();
