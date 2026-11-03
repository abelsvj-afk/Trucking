import { z } from "zod";

// GAP-03 (Fresh-Eyes Register 2026-11-02): facility memory.
const facilityFieldsSchema = z.object({
  name: z.string().min(1, "name is required."),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().length(2).optional(),
  kind: z.enum(["shipper", "receiver", "both"]).optional(),
  checkin_notes: z.string().optional(),
  dock_notes: z.string().optional(),
  parking_notes: z.string().optional(),
  detention_notes: z.string().optional(),
  hours_notes: z.string().optional(),
  contact_name: z.string().optional(),
  contact_phone: z.string().optional(),
  visit_count: z.number().int().nonnegative().optional(),
  last_visited_at: z.string().optional(),
});

export const createFacilitySchema = facilityFieldsSchema;
export const updateFacilitySchema = facilityFieldsSchema.partial();
