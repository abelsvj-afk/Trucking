import { z } from "zod";

export const createMaintenanceEventSchema = z.object({
  truck_id: z.string().uuid(),
  description: z.string().min(1, "description is required."),
  cost_cents: z.number().int().nonnegative("cost_cents must not be negative.").nullable().optional(),
  service_date: z.string().min(1, "service_date is required."),
  mileage_at_service: z
    .number()
    .int()
    .nonnegative("mileage_at_service must not be negative.")
    .nullable()
    .optional(),
});

export const updateMaintenanceEventSchema = createMaintenanceEventSchema.partial();
