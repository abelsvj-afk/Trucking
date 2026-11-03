// GAP-14 (Fresh-Eyes Register 2026-11-02): dated broker follow-ups.

import { z } from "zod";

const followupFieldsSchema = z.object({
  broker_id: z.string().uuid(),
  note: z.string().min(1, "note is required."),
  due_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "due_on must be YYYY-MM-DD."),
  done_at: z.string().nullable().optional(),
});

export const createBrokerFollowupSchema = followupFieldsSchema;
export const updateBrokerFollowupSchema = followupFieldsSchema.partial();
