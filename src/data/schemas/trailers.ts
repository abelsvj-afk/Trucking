import { z } from "zod";

export const trailerStatusSchema = z.enum(["active", "maintenance", "inactive"]);

export const createTrailerSchema = z.object({
  unit_number: z.string().min(1, "unit_number is required."),
  vin: z.string().optional(),
  trailer_type: z.string().optional(),
  status: trailerStatusSchema.optional(),
});

export const updateTrailerSchema = createTrailerSchema.partial();
