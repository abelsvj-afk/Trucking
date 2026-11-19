// GET  /api/v1/voice-notes?lat=&lng=&radius=  - coworker notes still for me near a point
// GET  /api/v1/voice-notes?mine=1             - my own live notes (to remove them)
// POST /api/v1/voice-notes  (multipart: audio + kind, lat, lng, heading, roadRef, durationS)
// Location voice notes, migration 00101; design docs/design/voice-notes.md.
import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { validationError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { voiceNoteCreateFieldsSchema, voiceNotesNearQuerySchema } from "@/data/schemas/voice-notes";
import { createVoiceNote, listMyVoiceNotes, listVoiceNotesNear, VoiceNoteError } from "@/services/api/voice-notes";

export const GET = createApiHandler(async (req, { auth }) => {
  const supabase = await createClient();
  if (req.nextUrl.searchParams.get("mine") === "1") {
    return NextResponse.json({ data: await listMyVoiceNotes(supabase, auth) });
  }
  const parsed = voiceNotesNearQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) throw validationError("lat and lng are required numbers; radius is 1-60 miles.");
  const { lat, lng, radius } = parsed.data;
  const { notes, memberCount } = await listVoiceNotesNear(supabase, auth, { lat, lng }, radius);
  return NextResponse.json({ data: { notes, memberCount } });
});

export const POST = createApiHandler(async (req, { auth }) => {
  const form = await req.formData().catch(() => null);
  if (!form) throw validationError("Send the recording as multipart form data.");
  const audio = form.get("audio");
  if (!(audio instanceof Blob)) throw validationError("The recording is missing.");
  const fields = voiceNoteCreateFieldsSchema.safeParse({
    kind: form.get("kind"),
    lat: form.get("lat"),
    lng: form.get("lng"),
    heading: form.get("heading") ?? undefined,
    roadRef: form.get("roadRef") ?? undefined,
    durationS: form.get("durationS"),
  });
  if (!fields.success) throw validationError("Kind, position and length are required.");
  const f = fields.data;
  try {
    const supabase = await createClient();
    const { id } = await createVoiceNote(supabase, auth, {
      kind: f.kind,
      point: { lat: f.lat, lng: f.lng },
      headingDeg: typeof f.heading === "number" ? f.heading : null,
      roadRef: f.roadRef ? f.roadRef : null,
      durationS: f.durationS,
      audio,
      contentType: audio.type,
    });
    return NextResponse.json({ data: { id } }, { status: 201 });
  } catch (err) {
    if (err instanceof VoiceNoteError) throw validationError(err.message);
    throw err;
  }
});
