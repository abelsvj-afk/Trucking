// Outbound phone calling, pure helpers (docs/design/outbound-calling.md).
// No I/O here: phone math, voice resolution, cost math, and the fixed
// phrases Abel speaks. The fixed phrases are constant full sentences -
// never assembled from fragments - because the owner requires the call
// to sound natural, like someone talking, not stitched pieces.

/** Telnyx AI Assistants minute: orchestration + STT + TTS (LLM billed separately). */
export const ASSISTANT_CENTS_PER_MIN = 5;
/** Telnyx outbound call leg, ~$0.007/min, rounded up to whole cents per minute. */
export const TELEPHONY_CENTS_PER_MIN = 1;
/** Speech runs about 800 ElevenLabs characters a minute. */
export const ELEVENLABS_CHARS_PER_MIN = 800;

/** A US number in E.164 (`+1` + 10 digits), or null when it isn't one. */
export function normalizeUsPhone(input: string): string | null {
  const digits = input.replace(/[^0-9]/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length !== 10) return null;
  // NANP: area code and exchange both start 2-9. Short codes, 911-style
  // numbers, and non-US numbers never survive this.
  if (!/^[2-9][0-9]{2}[2-9][0-9]{6}$/.test(ten)) return null;
  return `+1${ten}`;
}

/** `(555) 123-4567` for an E.164 number; the input back untouched when it isn't one. */
export function formatPhoneForDisplay(e164: string): string {
  const match = /^\+1([2-9][0-9]{2})([2-9][0-9]{2})([0-9]{4})$/.exec(e164);
  if (!match) return e164;
  return `(${match[1]}) ${match[2]}-${match[3]}`;
}

export type CallVoiceProvider = "telnyx" | "elevenlabs";

export interface ResolvedCallVoice {
  /** The Telnyx voice string to send per call, or null for the Telnyx default. */
  telnyxVoice: string | null;
  provider: CallVoiceProvider;
  /** Plain-words cost of this voice, shown where he picks it. */
  costLabel: string;
}

/**
 * The stored `companies.call_voice_id` is a Telnyx voice string from the
 * live catalog, as-is: ElevenLabs voices arrive as
 * `elevenlabs.eleven_turbo_v2_5.<VoiceId>` and Telnyx built-ins as their
 * catalog name (e.g. `Telnyx.KokoroTTS.af_heart`). The `elevenlabs.`
 * prefix is what marks an ElevenLabs voice. Null means the Telnyx
 * default built-in voice.
 */
export function resolveCallVoice(voiceId: string | null | undefined): ResolvedCallVoice {
  if (!voiceId) {
    return {
      telnyxVoice: null,
      provider: "telnyx",
      costLabel: "Telnyx voice, included in the call minute — no extra cost",
    };
  }
  if (voiceId.startsWith("elevenlabs.")) {
    return {
      telnyxVoice: voiceId,
      provider: "elevenlabs",
      costLabel:
        "ElevenLabs voice — uses characters from his ElevenLabs plan (about 800 a minute, roughly 16 three-minute calls a month on Starter)",
    };
  }
  return {
    telnyxVoice: voiceId,
    provider: "telnyx",
    costLabel: "Telnyx voice, included in the call minute — no extra cost",
  };
}

export interface CallCostEstimate {
  assistantCents: number;
  telephonyCents: number;
  /** Whole-minute cost in cents, before LLM tokens and ElevenLabs characters. */
  totalCents: number;
  elevenLabsChars: number | null;
}

/** Whole-minute cost of a call, in cents. ElevenLabs characters are separate (his quota). */
export function estimateCallCost(minutes: number, provider: CallVoiceProvider): CallCostEstimate {
  const wholeMinutes = Math.max(1, Math.ceil(minutes));
  return {
    assistantCents: wholeMinutes * ASSISTANT_CENTS_PER_MIN,
    telephonyCents: wholeMinutes * TELEPHONY_CENTS_PER_MIN,
    totalCents: wholeMinutes * (ASSISTANT_CENTS_PER_MIN + TELEPHONY_CENTS_PER_MIN),
    elevenLabsChars: provider === "elevenlabs" ? wholeMinutes * ELEVENLABS_CHARS_PER_MIN : null,
  };
}

/**
 * The first thing the caller hears: one full sentence, fixed text.
 * The assistant's greeting is this line - it is never re-composed per call.
 */
export function buildCallGreeting(toName: string, purpose: string): string {
  return `Hi ${toName}, this is Abel calling from Road to Legacy Trucking about ${purpose}.`;
}

/** What the assistant leaves when the call reaches voicemail: one full sentence, fixed text. */
export function buildVoicemailMessage(purpose: string, fromNumber: string): string {
  return (
    `Hi, this is Abel calling from Road to Legacy Trucking about ${purpose}. ` +
    `Please call us back at ${formatPhoneForDisplay(fromNumber)}. Thanks.`
  );
}

/** The closing line: one full sentence, fixed text. */
export const CALL_CLOSING_LINE = "Thanks, I'll pass that along.";

/** `America/New_York` time with its zone label - never a bare UTC stamp. */
export function formatCallTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${parts} ET`;
}
