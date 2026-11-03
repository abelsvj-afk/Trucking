import { z } from "zod";

// GAP-04 (Fresh-Eyes Register 2026-11-02): the facility clock.
// occurred_at defaults to now in the route when omitted — a stamp
// is "I just got to the door", tapped in the moment.
export const createDetentionStampSchema = z.object({
  stamp_type: z.enum(["arrival", "door", "loading_done", "departure"]),
  stop_kind: z.enum(["pickup", "delivery"]).optional(),
  occurred_at: z.string().optional(),
  notes: z.string().optional(),
});

export const updateDetentionStampSchema = z.object({
  occurred_at: z.string().optional(),
  notes: z.string().optional(),
});
