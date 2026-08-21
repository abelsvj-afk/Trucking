import { z } from "zod";

export const driverStatusSchema = z.enum(["active", "inactive"]);

export const createDriverSchema = z.object({
  name: z.string().min(1, "name is required."),
  cdl_number: z.string().optional(),
  assigned_truck_id: z.string().uuid().nullable().optional(),
  status: driverStatusSchema.optional(),
});

export const updateDriverSchema = createDriverSchema.partial();
