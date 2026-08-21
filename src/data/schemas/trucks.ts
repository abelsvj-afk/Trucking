// Task 3.1 (TASKS.md). Validation schema for trucks, per docs/schemas.md.
// This is the actual enforcement point for docs/api-contracts.md's
// "reject invalid input with 400" rule - checked in validateBody() before
// services/db is ever called.

import { z } from "zod";

export const truckStatusSchema = z.enum(["active", "maintenance", "inactive"]);

export const createTruckSchema = z.object({
  unit_number: z.string().min(1, "unit_number is required."),
  vin: z.string().optional(),
  make: z.string().optional(),
  model: z.string().optional(),
  year: z.number().int().optional(),
  status: truckStatusSchema.optional(),
  current_mileage: z.number().int().nonnegative("current_mileage must not be negative.").optional(),
});

export const updateTruckSchema = createTruckSchema.partial();
