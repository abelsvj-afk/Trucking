// Abel Intelligence Upgrade, Phase E (design §6). Telegram voice
// note → text: the note is downloaded through the Bot API (the
// photo-intake getFile pattern), transcribed through the configured
// provider (services/ai/transcription.ts), and the transcript
// enters the SAME pipeline as a typed message - persisted with a
// "[voice]" marker so the timeline shows how it arrived.
//
// Failure honesty, per the design's backend-self-report rule:
// - the voice_transcription capability OFF -> a plain reply saying
//   so, with where to turn it on; nothing stored, nothing faked.
// - no provider configured -> a plain reply saying transcription
//   isn't set up on the server; nothing stored.
// - download/transcription failure -> a plain reply, nothing
//   stored, retry invited.
// - over the duration cap -> named as too long, not truncated
//   silently.

export interface TelegramVoice {
  file_id: string;
  file_unique_id?: string;
  /** Seconds, as Telegram reports it. */
  duration?: number;
  mime_type?: string;
  file_size?: number;
}

/** Voice notes past this are statements, not messages - the reply asks him to split or type instead of silently eating a truncated transcript. */
export const MAX_VOICE_SECONDS = 600;

export interface TelegramVoiceIntakeDeps {
  botToken: string;
  /** The voice_transcription kill switch (Settings) - checked in the webhook's wiring from the brain store. */
  isEnabled: () => Promise<boolean>;
  /** Injectable for tests; defaults to the configured provider transcription. */
  transcribe?: (audio: Buffer, mimeType: string) => Promise<string>;
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
}

export type VoiceIntakeResult =
  | { kind: "transcript"; text: string }
  | { kind: "reply"; text: string };

const OFF_REPLY =
  "Voice notes are turned off right now — the Voice transcription switch is off, so I didn't listen to that. You can turn it on in the app: More → Account & settings → Voice transcription. Type it for now and I'll work it the same way.";

const NOT_CONFIGURED_REPLY =
  "I got your voice note, but voice transcription isn't set up on the server yet (no transcription provider is configured), so I couldn't turn it into text — nothing was saved from it. Type it for now and I'll work it the same way.";

const FAILED_REPLY =
  "I couldn't transcribe that voice note — the download or the transcription failed, and nothing was saved. Send it again, or type it and I'll work it the same way.";

export async function handleTelegramVoice(
  voice: TelegramVoice,
  deps: TelegramVoiceIntakeDeps,
): Promise<VoiceIntakeResult> {
  if (voice.duration != null && voice.duration > MAX_VOICE_SECONDS) {
    return {
      kind: "reply",
      text: `That voice note is ${Math.round(voice.duration / 60)} minutes — over the ${MAX_VOICE_SECONDS / 60}-minute cap for transcription, so I didn't process it rather than hand you a cut-off transcript. Split it into shorter notes, or type the key parts.`,
    };
  }
  let enabled = false;
  try {
    enabled = await deps.isEnabled();
  } catch (err) {
    console.error("[telegram] voice capability check failed", err);
  }
  if (!enabled) return { kind: "reply", text: OFF_REPLY };

  const { isTranscriptionConfigured, transcribeAudio } = await import("@/services/ai/transcription");
  if (!deps.transcribe && !isTranscriptionConfigured()) {
    return { kind: "reply", text: NOT_CONFIGURED_REPLY };
  }

  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const fileResponse = await fetchFn(
      `https://api.telegram.org/bot${deps.botToken}/getFile?file_id=${encodeURIComponent(voice.file_id)}`,
    );
    const fileData = (await fileResponse.json()) as { ok?: boolean; result?: { file_path?: string } };
    const filePath = fileData.result?.file_path;
    if (!fileData.ok || !filePath) return { kind: "reply", text: FAILED_REPLY };
    const audioResponse = await fetchFn(`https://api.telegram.org/file/bot${deps.botToken}/${filePath}`);
    if (!audioResponse.ok) return { kind: "reply", text: FAILED_REPLY };
    const audio = Buffer.from(await audioResponse.arrayBuffer());
    const mimeType = voice.mime_type ?? "audio/ogg";
    const text = deps.transcribe
      ? await deps.transcribe(audio, mimeType)
      : await transcribeAudio(audio, { mimeType, fileName: "voice.ogg" });
    if (!text) return { kind: "reply", text: FAILED_REPLY };
    return { kind: "transcript", text };
  } catch (err) {
    console.error("[telegram] voice intake failed", err);
    return { kind: "reply", text: FAILED_REPLY };
  }
}
