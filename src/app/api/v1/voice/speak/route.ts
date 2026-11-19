// POST /api/v1/voice/speak { text } -> { data: { url | null, source | reason } }
// A spoken drive line in his ElevenLabs voice, generated at most once and then
// served from his saved clips (services/voice/spoken-clips.ts). url null = the
// app speaks it with the phone's own voice instead (not configured, monthly
// budget reached, provider down) — speech never goes silent.
import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { validationError } from "@/services/api/errors";
import { createClient } from "@/services/db/server";
import { MAX_SPOKEN_CHARS, spokenClip, voiceConfig } from "@/services/voice/spoken-clips";

const bodySchema = z.object({ text: z.string().min(1).max(MAX_SPOKEN_CHARS) });

export const POST = createApiHandler(async (req, { auth }) => {
  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) throw validationError(`Send { text } of 1-${MAX_SPOKEN_CHARS} characters.`);
  const supabase = await createClient();
  const { data } = await supabase.from("companies").select("call_voice_id").eq("id", auth.companyId).maybeSingle();
  const callVoice = typeof (data as { call_voice_id?: unknown } | null)?.call_voice_id === "string" ? (data as { call_voice_id: string }).call_voice_id : null;
  const result = await spokenClip(body.data.text, { client: supabase, companyId: auth.companyId, config: voiceConfig(callVoice) });
  return NextResponse.json({ data: result });
});
