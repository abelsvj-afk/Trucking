// Driver MVP (docs/design/driver-mvp.md §3). One row per duty-status
// start; a status runs until the next row's started_at.

import { z } from "zod";

export const dutyStatusSchema = z.enum(["off_duty", "sleeper", "driving", "on_duty"]);

export const dutyLogEditSourceSchema = z.enum(["app", "conversation", "paper"]);

const dutyLogFieldsSchema = z.object({
  driver_id: z.string().uuid().nullable().optional(),
  // GAP-07: client-generated id for safe offline replay (create only
  // in practice; updates address rows by URL id).
  id: z.string().uuid().optional(),
  load_id: z.string().uuid().nullable().optional(),
  duty_status: dutyStatusSchema,
  started_at: z.string().min(1, "started_at is required."),
  location: z.string().nullable().optional(),
  odometer: z.number().int().nonnegative("odometer must not be negative.").nullable().optional(),
  notes: z.string().nullable().optional(),
  // Edit-trail meta (spec §2.2, migration 00088): WHY a correction is
  // being made and which surface made it. These ride the create/update
  // payloads so the write path can record the trail row, but they are
  // NEVER duty_logs columns - the duty-log routes' prepareCreate /
  // prepareUpdate strip them from every write payload.
  edit_reason: z.string().trim().min(1, "A reason is required to correct a duty entry.").optional(),
  edit_source: dutyLogEditSourceSchema.optional(),
});

export const createDutyLogSchema = dutyLogFieldsSchema;
export const updateDutyLogSchema = dutyLogFieldsSchema.partial();
