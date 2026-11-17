// Voice options for Settings -> Abel and AI -> "Voice on calls"
// (docs/design/outbound-calling.md). The Telnyx default is always
// offered; the live catalog (Telnyx built-ins + ElevenLabs voices) is
// listed only when Telnyx is configured. ElevenLabs entries cost
// characters from his ElevenLabs plan; Telnyx voices are included in
// the call minute. Never fails when Telnyx isn't set up - it just
// offers the default and says calling isn't connected yet.

import { NextResponse } from "next/server";
import { createApiHandler } from "@/services/api/handler";
import { createClient } from "@/services/db/server";
import { getCallingConfig } from "@/services/calling/config";
import { listTelnyxVoices } from "@/services/calling/telnyx";

export const GET = createApiHandler(async (_req, ctx) => {
  const supabase = await createClient();
  const config = getCallingConfig();
  const configured = Boolean(config.telnyxApiKey);
  const { data } = await supabase
    .from("companies")
    .select("call_voice_id")
    .eq("id", ctx.auth.companyId)
    .maybeSingle();
  const selected =
    typeof (data as { call_voice_id?: unknown } | null)?.call_voice_id === "string"
      ? ((data as { call_voice_id: string }).call_voice_id as string)
      : null;

  const voices: { id: string | null; label: string; provider: string; cost_note: string }[] = [
    {
      id: null,
      label: "Telnyx default voice",
      provider: "telnyx",
      cost_note: "Included in the call minute — no extra cost.",
    },
  ];
  if (configured) {
    const catalog = await listTelnyxVoices(config, fetch);
    for (const voice of catalog) {
      const isElevenLabs =
        voice.provider.toLowerCase() === "elevenlabs" || voice.id.startsWith("elevenlabs.");
      voices.push({
        id: voice.id,
        label: voice.label,
        provider: isElevenLabs ? "elevenlabs" : "telnyx",
        cost_note: isElevenLabs
          ? "ElevenLabs voice — uses characters from his ElevenLabs plan (about 800 a minute)."
          : "Included in the call minute — no extra cost.",
      });
    }
  }
  return NextResponse.json({ configured, selected, voices });
});
