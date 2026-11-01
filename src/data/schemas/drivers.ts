import { z } from "zod";

export const driverStatusSchema = z.enum(["active", "inactive"]);

// UI/UX upgrade (migration 00027): a closed role set the Add/Edit
// Driver picklist and the assistant's write tools can both rely on,
// instead of free text that drifts ("owner op", "Owner-Operator", ...).
export const driverRoleSchema = z.enum([
  "owner_operator",
  "company_driver",
  "contract_driver",
  "other",
]);

export const createDriverSchema = z.object({
  name: z.string().min(1, "name is required."),
  phone: z.string().max(40).optional(),
  role: driverRoleSchema.optional(),
  cdl_number: z.string().optional(),
  // Plain string like every other date field in this codebase (loads'
  // pickup_date/delivery_date) - the DB column is a date, and an
  // <input type="date"> produces exactly this shape.
  cdl_expires_on: z.string().optional(),
  // The documents row holding this driver's photo (migration 00027).
  photo_document_id: z.string().uuid().nullable().optional(),
  assigned_truck_id: z.string().uuid().nullable().optional(),
  status: driverStatusSchema.optional(),
});

export const updateDriverSchema = createDriverSchema.partial();
