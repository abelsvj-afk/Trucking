// POST /api/v1/voice-notes/:id/report { kind: "gone" | "bad" } - one per driver per kind.
// Enough reports (lib/voice-notes.ts clearThreshold, by fleet size) clear it for everyone.
import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { validationError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { voiceNoteIdSchema, voiceNoteReportSchema } from "@/data/schemas/voice-notes";
import { reportVoiceNote } from "@/services/api/voice-notes";

export const POST = createApiHandler(async (req, { auth, params }) => {
  const id = voiceNoteIdSchema.safeParse(params.id);
  const body = voiceNoteReportSchema.safeParse(await req.json().catch(() => null));
  if (!id.success || !body.success) throw validationError('Send { kind: "gone" } or { kind: "bad" }.');
  await reportVoiceNote(await createClient(), auth, id.data, body.data.kind);
  return NextResponse.json({ data: { ok: true } });
});
