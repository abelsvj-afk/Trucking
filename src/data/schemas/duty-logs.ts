// Driver MVP (docs/design/driver-mvp.md §3). One row per duty-status
// start; a status runs until the next row's started_at.

import { z } from "zod";

export const dutyStatusSchema = z.enum(["off_duty", "sleeper", "driving", "on_duty"]);

const dutyLogFieldsSchema = z.object({
  driver_id: z.string().uuid().nullable().optional(),
  load_id: z.string().uuid().nullable().optional(),
  duty_status: dutyStatusSchema,
  started_at: z.string().min(1, "started_at is required."),
  location: z.string().nullable().optional(),
  odometer: z.number().int().nonnegative("odometer must not be negative.").nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const createDutyLogSchema = dutyLogFieldsSchema;
export const updateDutyLogSchema = dutyLogFieldsSchema.partial();
