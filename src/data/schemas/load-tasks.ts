import { z } from "zod";

// Trip intake (migration 00061): a dispatcher requirement on one load.
export const createLoadTaskSchema = z.object({
  load_id: z.string().uuid(),
  text: z.string().trim().min(1, "text is required."),
  stop_kind: z.enum(["pickup", "delivery", "every_stop"]).nullable().optional(),
  sort_order: z.number().int().optional(),
});

// done_at is set only when the owner records it (null = not done).
export const updateLoadTaskSchema = z.object({
  text: z.string().trim().min(1).optional(),
  done_at: z.string().nullable().optional(),
});
