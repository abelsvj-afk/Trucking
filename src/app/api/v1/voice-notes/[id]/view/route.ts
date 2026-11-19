// POST /api/v1/voice-notes/:id/view { listened?, passed? } - this driver's own state.
import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { validationError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { voiceNoteIdSchema, voiceNoteViewSchema } from "@/data/schemas/voice-notes";
import { markVoiceNoteView } from "@/services/api/voice-notes";

export const POST = createApiHandler(async (req, { auth, params }) => {
  const id = voiceNoteIdSchema.safeParse(params.id);
  const body = voiceNoteViewSchema.safeParse(await req.json().catch(() => null));
  if (!id.success || !body.success) throw validationError("Send { listened: true } and/or { passed: true }.");
  await markVoiceNoteView(await createClient(), auth, id.data, body.data);
  return NextResponse.json({ data: { ok: true } });
});
