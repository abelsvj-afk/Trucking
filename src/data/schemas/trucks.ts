// Task 3.1 (TASKS.md). Validation schema for trucks, per docs/schemas.md.
// This is the actual enforcement point for docs/api-contracts.md's
// "reject invalid input with 400" rule - checked in validateBody() before
// services/db is ever called.

import { z } from "zod";

export const truckStatusSchema = z.enum(["active", "maintenance", "inactive"]);

// Smart Path v1 (docs/design/driver-mvp.md §8.2): the known appliance
// values. Kept identical to src/types/entities.ts's TruckAppliance.
export const truckApplianceSchema = z.enum([
  "fridge",
  "cooler",
  "microwave",
  "air_fryer",
  "hot_plate",
  "coffee_maker",
  "inverter",
  "none",
]);

const appliancesSchema = z
  .array(truckApplianceSchema)
  .refine((values) => !values.includes("none") || values.length === 1, {
    message: "appliances: 'none' means nothing in the cab and cannot be combined with other appliances.",
  })
  .optional();

export const createTruckSchema = z.object({
  unit_number: z.string().min(1, "unit_number is required."),
  vin: z.string().optional(),
  make: z.string().optional(),
  model: z.string().optional(),
  year: z.number().int().optional(),
  status: truckStatusSchema.optional(),
  current_mileage: z.number().int().nonnegative("current_mileage must not be negative.").optional(),
  // UI/UX upgrade (migration 00027): what kind of truck this is. Free
  // text, same precedent as trailers.trailer_type - the UI offers a
  // picklist (sleeper_semi, day_cab_semi, box_truck, straight_truck,
  // hotshot) and stores the owner's own words for anything else.
  truck_type: z.string().min(1).max(60).optional(),
  // The documents row holding this truck's photo (migration 00027) -
  // the file itself rides the documents storage pipeline.
  photo_document_id: z.string().uuid().nullable().optional(),
  // Truck profile (migration 00017) - all optional until captured.
  height_in: z.number().int().positive("height_in must be positive.").optional(),
  length_in: z.number().int().positive("length_in must be positive.").optional(),
  weight_lbs: z.number().int().positive("weight_lbs must be positive.").optional(),
  governed_speed_mph: z
    .number()
    .int()
    .min(20, "governed_speed_mph looks too low for a truck.")
    .max(100, "governed_speed_mph looks too high for a truck.")
    .optional(),
  tank_capacity_gallons: z.number().positive("tank_capacity_gallons must be positive.").optional(),
  avg_mpg: z
    .number()
    .min(2, "avg_mpg looks too low for a truck.")
    .max(20, "avg_mpg looks too high for a truck.")
    .optional(),
  appliances: appliancesSchema,
  appliance_notes: z.string().max(1000).optional(),
});

export const updateTruckSchema = createTruckSchema.partial();
