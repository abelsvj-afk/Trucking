// GET /api/v1/voice-notes/:id/audio - a 5-minute signed link to play the note.
import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { notFound, validationError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { voiceNoteIdSchema } from "@/data/schemas/voice-notes";
import { voiceNoteAudioUrl, VoiceNoteError } from "@/services/api/voice-notes";

export const GET = createApiHandler(async (_req, { params }) => {
  const id = voiceNoteIdSchema.safeParse(params.id);
  if (!id.success) throw validationError("Bad note id.");
  try {
    return NextResponse.json({ data: { url: await voiceNoteAudioUrl(await createClient(), id.data) } });
  } catch (err) {
    if (err instanceof VoiceNoteError) throw notFound();
    throw err;
  }
});
