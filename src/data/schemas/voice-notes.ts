// Contracts for location voice notes (docs/api-contracts.md, migration 00101).
import { z } from "zod";
import { VOICE_NOTE_KINDS } from "@/lib/voice-notes";

export const voiceNoteKindSchema = z.enum(VOICE_NOTE_KINDS);

export const voiceNotesNearQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().min(1).max(60).default(35),
});

/** The text fields of the multipart create (the audio is the `audio` file part). */
export const voiceNoteCreateFieldsSchema = z.object({
  kind: voiceNoteKindSchema,
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  heading: z.union([z.literal(""), z.coerce.number().min(0).lt(360)]).optional(),
  roadRef: z.string().max(20).optional(),
  durationS: z.coerce.number().positive().max(61),
});

export const voiceNoteViewSchema = z
  .object({ listened: z.boolean().optional(), passed: z.boolean().optional() })
  .refine((v) => v.listened || v.passed, "Say listened and/or passed.");

export const voiceNoteReportSchema = z.object({ kind: z.enum(["gone", "bad"]) });

export const voiceNoteIdSchema = z.string().uuid();
