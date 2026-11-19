// Location voice notes — data access (migration 00101; rules in
// lib/voice-notes.ts; design docs/design/voice-notes.md). Every call runs
// with the caller's own session, so row-level security does the tenant
// isolation; the audio lives in the private `documents` bucket under
// <company>/voice-notes/ (00007's storage policies).

import type { SupabaseClient } from "@supabase/supabase-js";
import { haversineMiles, type LatLng } from "@/lib/smart-path";
import {
  expiresAtFor,
  notesForViewer,
  VOICE_NOTE_MAX_SECONDS,
  type VoiceNoteKind,
  type VoiceNoteRecord,
} from "@/lib/voice-notes";

const BUCKET = "documents";
/** Audio types a phone's MediaRecorder produces; nothing else is stored. */
export const VOICE_NOTE_AUDIO_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/aac"] as const;
/** 30 s of compressed speech is well under this. */
export const VOICE_NOTE_MAX_BYTES = 1_500_000;
const SIGNED_URL_TTL_S = 5 * 60;

export class VoiceNoteError extends Error {
  constructor(
    message: string,
    readonly kind: "validation" | "not_found",
  ) {
    super(message);
  }
}

interface NoteRow {
  id: string;
  author_id: string;
  kind: VoiceNoteKind;
  lat: number;
  lng: number;
  heading_deg: number | null;
  road_ref: string | null;
  duration_s: number;
  created_at: string;
  expires_at: string | null;
  removed_at: string | null;
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : null);

export async function memberCount(client: SupabaseClient): Promise<number> {
  const { data, error } = await client.rpc("company_member_count");
  if (error) throw new Error(error.message);
  return typeof data === "number" && data > 0 ? data : 1;
}

/** Notes still for this viewer within `radiusMiles` of `near` (newest first). */
export async function listVoiceNotesNear(
  client: SupabaseClient,
  viewer: { userId: string; companyId: string },
  near: LatLng,
  radiusMiles: number,
  nowMs: number = Date.now(),
): Promise<{ notes: VoiceNoteRecord[]; memberCount: number }> {
  // A coarse box first (indexed by company), then the exact distance.
  const dLat = radiusMiles / 69.09;
  const dLng = radiusMiles / (69.17 * Math.max(0.2, Math.cos((near.lat * Math.PI) / 180)));
  const { data, error } = await client
    .from("voice_notes")
    .select("id, author_id, kind, lat, lng, heading_deg, road_ref, duration_s, created_at, expires_at, removed_at")
    .eq("company_id", viewer.companyId)
    .is("removed_at", null)
    .gte("lat", near.lat - dLat)
    .lte("lat", near.lat + dLat)
    .gte("lng", near.lng - dLng)
    .lte("lng", near.lng + dLng)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as NoteRow[]).filter((r) => haversineMiles(near, { lat: r.lat, lng: r.lng }) <= radiusMiles);
  const ids = rows.map((r) => r.id);
  const members = await memberCount(client);
  if (ids.length === 0) return { notes: [], memberCount: members };

  const [views, reports] = await Promise.all([
    client.from("voice_note_views").select("note_id, listened_at, passed_at").eq("user_id", viewer.userId).in("note_id", ids),
    client.from("voice_note_reports").select("note_id, user_id, kind").in("note_id", ids),
  ]);
  if (views.error) throw new Error(views.error.message);
  if (reports.error) throw new Error(reports.error.message);
  const viewBy = new Map((views.data ?? []).map((v) => [v.note_id as string, v as { listened_at: string | null; passed_at: string | null }]));
  const reportRows = (reports.data ?? []) as { note_id: string; user_id: string; kind: "gone" | "bad" }[];

  const records: VoiceNoteRecord[] = rows.map((r) => {
    const mine = reportRows.filter((x) => x.note_id === r.id);
    const v = viewBy.get(r.id);
    return {
      id: r.id,
      authorId: r.author_id,
      kind: r.kind,
      point: { lat: r.lat, lng: r.lng },
      headingDeg: r.heading_deg,
      roadRef: r.road_ref,
      durationS: r.duration_s,
      createdAtMs: Date.parse(r.created_at),
      expiresAtMs: ms(r.expires_at),
      removedAtMs: ms(r.removed_at),
      // The author's own report never counts toward clearing his note for others (he removes it instead).
      goneReports: mine.filter((x) => x.kind === "gone" && x.user_id !== r.author_id).length,
      badReports: mine.filter((x) => x.kind === "bad" && x.user_id !== r.author_id).length,
      listenedAtMs: ms(v?.listened_at ?? null),
      passedAtMs: ms(v?.passed_at ?? null),
      reportedByMe: mine.some((x) => x.user_id === viewer.userId),
    };
  });
  return { notes: notesForViewer(records, viewer.userId, members, nowMs), memberCount: members };
}

export interface CreateVoiceNoteInput {
  kind: VoiceNoteKind;
  point: LatLng;
  headingDeg: number | null;
  roadRef: string | null;
  durationS: number;
  audio: Blob;
  contentType: string;
}

export async function createVoiceNote(
  client: SupabaseClient,
  viewer: { userId: string; companyId: string },
  input: CreateVoiceNoteInput,
  nowMs: number = Date.now(),
): Promise<{ id: string }> {
  const type = input.contentType.split(";")[0]!.trim().toLowerCase();
  if (!(VOICE_NOTE_AUDIO_TYPES as readonly string[]).includes(type)) throw new VoiceNoteError("That recording format isn't supported.", "validation");
  if (input.audio.size === 0 || input.audio.size > VOICE_NOTE_MAX_BYTES) throw new VoiceNoteError("The recording is empty or too long.", "validation");
  if (!(input.durationS > 0) || input.durationS > VOICE_NOTE_MAX_SECONDS + 1) throw new VoiceNoteError(`Voice notes are up to ${VOICE_NOTE_MAX_SECONDS} seconds.`, "validation");

  const ext = type === "audio/mp4" || type === "audio/aac" ? "m4a" : type === "audio/mpeg" ? "mp3" : type === "audio/ogg" ? "ogg" : "webm";
  const path = `${viewer.companyId}/voice-notes/${crypto.randomUUID()}.${ext}`;
  const upload = await client.storage.from(BUCKET).upload(path, input.audio, { contentType: type });
  if (upload.error) throw new Error(upload.error.message);

  const expires = expiresAtFor(input.kind, nowMs);
  const { data, error } = await client
    .from("voice_notes")
    .insert({
      company_id: viewer.companyId,
      author_id: viewer.userId,
      kind: input.kind,
      lat: input.point.lat,
      lng: input.point.lng,
      heading_deg: input.headingDeg,
      road_ref: input.roadRef,
      storage_path: path,
      duration_s: Math.min(VOICE_NOTE_MAX_SECONDS, input.durationS),
      created_at: new Date(nowMs).toISOString(),
      expires_at: expires === null ? null : new Date(expires).toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) {
    // No orphaned audio: take the file back out if the row didn't land.
    await client.storage.from(BUCKET).remove([path]);
    throw new Error(error?.message ?? "Voice note row was not created.");
  }
  return { id: (data as { id: string }).id };
}

/** A short-lived link to play the note. */
export async function voiceNoteAudioUrl(client: SupabaseClient, id: string): Promise<string> {
  const { data, error } = await client.from("voice_notes").select("storage_path").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new VoiceNoteError("That voice note is gone.", "not_found");
  const signed = await client.storage.from(BUCKET).createSignedUrl((data as { storage_path: string }).storage_path, SIGNED_URL_TTL_S);
  if (signed.error || !signed.data) throw new Error(signed.error?.message ?? "Could not sign the audio link.");
  return signed.data.signedUrl;
}

/** He listened and/or passed it. Never un-sets a time already recorded. */
export async function markVoiceNoteView(
  client: SupabaseClient,
  viewer: { userId: string; companyId: string },
  id: string,
  what: { listened?: boolean; passed?: boolean },
  nowMs: number = Date.now(),
): Promise<void> {
  const { data: existing, error: readError } = await client
    .from("voice_note_views")
    .select("listened_at, passed_at")
    .eq("note_id", id)
    .eq("user_id", viewer.userId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  const now = new Date(nowMs).toISOString();
  const prev = existing as { listened_at: string | null; passed_at: string | null } | null;
  const row = {
    note_id: id,
    user_id: viewer.userId,
    company_id: viewer.companyId,
    listened_at: prev?.listened_at ?? (what.listened ? now : null),
    passed_at: prev?.passed_at ?? (what.passed ? now : null),
  };
  const { error } = await client.from("voice_note_views").upsert(row, { onConflict: "note_id,user_id" });
  if (error) throw new Error(error.message);
}

export async function reportVoiceNote(
  client: SupabaseClient,
  viewer: { userId: string; companyId: string },
  id: string,
  kind: "gone" | "bad",
): Promise<void> {
  const { error } = await client
    .from("voice_note_reports")
    .upsert({ note_id: id, user_id: viewer.userId, company_id: viewer.companyId, kind }, { onConflict: "note_id,user_id,kind", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
}

/** The author removes his own note (row-level security refuses anyone else). */
export async function removeVoiceNote(client: SupabaseClient, viewer: { userId: string }, id: string): Promise<void> {
  const { data, error } = await client
    .from("voice_notes")
    .update({ removed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("author_id", viewer.userId)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new VoiceNoteError("Only the driver who left a note can remove it.", "not_found");
}

/** The viewer's own live notes (so he can find and remove them). */
export async function listMyVoiceNotes(client: SupabaseClient, viewer: { userId: string; companyId: string }, nowMs: number = Date.now()) {
  const { data, error } = await client
    .from("voice_notes")
    .select("id, kind, lat, lng, road_ref, created_at, expires_at")
    .eq("company_id", viewer.companyId)
    .eq("author_id", viewer.userId)
    .is("removed_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return ((data ?? []) as { id: string; kind: VoiceNoteKind; lat: number; lng: number; road_ref: string | null; created_at: string; expires_at: string | null }[]).filter(
    (r) => r.expires_at === null || Date.parse(r.expires_at) > nowMs,
  );
}
