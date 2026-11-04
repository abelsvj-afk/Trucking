// Abel Intelligence Upgrade, Phase E (design §6/§7). Voice-note
// transcription: Telegram voice messages become text and enter the
// same message pipeline as typed text. Provider story, honestly
// (the owner's free-first rule): there is NO free hosted
// transcription the repo already has keys for. The default path is
// OpenAI's Whisper API on the existing OPENAI_API_KEY at roughly
// $0.006 per minute of audio - pennies per note, but not $0. A true
// $0 path exists by configuration: Groq's free tier serves an
// OpenAI-compatible endpoint (whisper-large-v3) - set GROQ_API_KEY
// (or TRANSCRIPTION_BASE_URL + TRANSCRIPTION_API_KEY for any other
// OpenAI-compatible host, including a local whisper server) and
// transcription switches to it with no code change.
//
// Governance: voice_transcription is its own capability (kill
// switch in Settings, default OFF like every AI capability - no
// settings row = off). When the capability is off OR no provider
// key is configured, the voice path says so plainly and stores
// nothing - a voice note never fails silently.

export const VOICE_TRANSCRIPTION_CAPABILITY = "voice_transcription";

export interface TranscriptionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Where the config came from, for the honest status line. */
  source: "groq" | "custom" | "openai";
}

/** Resolves the transcription provider from env; null when no key exists anywhere (the honest "isn't configured" state). */
export function transcriptionConfig(env: NodeJS.ProcessEnv = process.env): TranscriptionConfig | null {
  const customKey = env.TRANSCRIPTION_API_KEY;
  if (customKey) {
    return {
      baseUrl: (env.TRANSCRIPTION_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
      apiKey: customKey,
      model: env.TRANSCRIPTION_MODEL ?? "whisper-1",
      source: env.TRANSCRIPTION_BASE_URL ? "custom" : "openai",
    };
  }
  if (env.GROQ_API_KEY) {
    return {
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: env.GROQ_API_KEY,
      model: env.TRANSCRIPTION_MODEL ?? "whisper-large-v3",
      source: "groq",
    };
  }
  if (env.OPENAI_API_KEY) {
    return {
      baseUrl: "https://api.openai.com/v1",
      apiKey: env.OPENAI_API_KEY,
      model: env.TRANSCRIPTION_MODEL ?? "whisper-1",
      source: "openai",
    };
  }
  return null;
}

export function isTranscriptionConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return transcriptionConfig(env) !== null;
}

/**
 * Transcribes one audio clip through the configured
 * OpenAI-compatible endpoint (multipart form: file + model).
 * Throws with the provider's status on failure - the caller turns
 * that into the owner's plain-words reply.
 */
export async function transcribeAudio(
  audio: Buffer,
  options: {
    config?: TranscriptionConfig | null;
    fileName?: string;
    mimeType?: string;
    fetchFn?: typeof fetch;
  } = {},
): Promise<string> {
  const config = options.config !== undefined ? options.config : transcriptionConfig();
  if (!config) {
    throw new Error("Voice transcription isn't configured on the server (no transcription API key).");
  }
  const fetchFn = options.fetchFn ?? fetch;
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(audio)], { type: options.mimeType ?? "audio/ogg" }),
    options.fileName ?? "voice.ogg",
  );
  form.append("model", config.model);
  const response = await fetchFn(`${config.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Transcription provider returned ${response.status}.`);
  }
  const data = (await response.json()) as { text?: unknown };
  if (typeof data.text !== "string" || data.text.trim() === "") {
    throw new Error("Transcription came back empty.");
  }
  return data.text.trim();
}
