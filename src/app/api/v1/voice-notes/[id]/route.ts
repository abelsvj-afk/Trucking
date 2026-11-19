// DELETE /api/v1/voice-notes/:id - the author removes his own note (soft: removed_at).
import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { notFound, validationError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { voiceNoteIdSchema } from "@/data/schemas/voice-notes";
import { removeVoiceNote, VoiceNoteError } from "@/services/api/voice-notes";

export const DELETE = createApiHandler(async (_req, { auth, params }) => {
  const id = voiceNoteIdSchema.safeParse(params.id);
  if (!id.success) throw validationError("Bad note id.");
  try {
    await removeVoiceNote(await createClient(), auth, id.data);
  } catch (err) {
    if (err instanceof VoiceNoteError) throw notFound();
    throw err;
  }
  return NextResponse.json({ data: { removed: true } });
});
