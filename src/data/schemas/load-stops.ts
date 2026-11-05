import { z } from "zod";

// Migration 00062. Created by the trip-intake flow; the owner records progress.
export const createLoadStopSchema = z.object({
  load_id: z.string().uuid(),
  seq: z.number().int().min(1),
  kind: z.enum(["pickup", "delivery", "other"]).optional(),
  name: z.string().optional(),
  address: z.string().optional(),
  appointment_at: z.string().optional(),
  appointment_tz: z.string().optional(),
});

// arrived / left / dispatcher-approved are set ONLY by the owner's tap (null clears a mis-tap).
export const updateLoadStopSchema = z.object({
  arrived_at: z.string().nullable().optional(),
  departed_at: z.string().nullable().optional(),
  approved_at: z.string().nullable().optional(),
  notes: z.string().optional(),
});
