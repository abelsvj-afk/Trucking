// Outbound calling pure helpers - docs/design/outbound-calling.md.
import { describe, expect, it } from "vitest";
import {
  buildCallGreeting,
  buildVoicemailMessage,
  CALL_CLOSING_LINE,
  estimateCallCost,
  formatCallTime,
  formatPhoneForDisplay,
  normalizeUsPhone,
  resolveCallVoice,
} from "@/lib/outbound-calling";

describe("normalizeUsPhone", () => {
  it("normalizes the shapes a number arrives in", () => {
    expect(normalizeUsPhone("(555) 234-5678")).toBe("+15552345678");
    expect(normalizeUsPhone("1-555-234-5678")).toBe("+15552345678");
    expect(normalizeUsPhone("+1 555 234 5678")).toBe("+15552345678");
    expect(normalizeUsPhone("5552345678")).toBe("+15552345678");
  });

  it("refuses short codes, 911-style numbers, and non-US numbers", () => {
    expect(normalizeUsPhone("555-1234")).toBeNull();
    expect(normalizeUsPhone("911")).toBeNull();
    expect(normalizeUsPhone("+44 20 7946 0958")).toBeNull();
    expect(normalizeUsPhone("1555123456")).toBeNull();
    expect(normalizeUsPhone("")).toBeNull();
  });

  it("refuses numbers with an invalid area code or exchange", () => {
    expect(normalizeUsPhone("(155) 123-4567")).toBeNull();
    expect(normalizeUsPhone("(555) 023-4567")).toBeNull();
  });
});

describe("formatPhoneForDisplay", () => {
  it("shows (555) 123-4567 and passes anything else through untouched", () => {
    expect(formatPhoneForDisplay("+15552345678")).toBe("(555) 234-5678");
    expect(formatPhoneForDisplay("not-a-number")).toBe("not-a-number");
  });
});

describe("resolveCallVoice", () => {
  it("null is the Telnyx default built-in voice, at no extra cost", () => {
    const voice = resolveCallVoice(null);
    expect(voice.provider).toBe("telnyx");
    expect(voice.telnyxVoice).toBeNull();
    expect(voice.costLabel).toContain("no extra cost");
  });

  it("an elevenlabs. voice keeps its full Telnyx voice string", () => {
    const voice = resolveCallVoice("elevenlabs.eleven_turbo_v2_5.abc123");
    expect(voice.provider).toBe("elevenlabs");
    expect(voice.telnyxVoice).toBe("elevenlabs.eleven_turbo_v2_5.abc123");
    expect(voice.costLabel).toContain("ElevenLabs");
  });

  it("a Telnyx built-in voice stays Telnyx", () => {
    const voice = resolveCallVoice("Telnyx.KokoroTTS.af_heart");
    expect(voice.provider).toBe("telnyx");
    expect(voice.telnyxVoice).toBe("Telnyx.KokoroTTS.af_heart");
  });
});

describe("estimateCallCost", () => {
  it("a 3-minute call is about $0.18 plus LLM, and 2,400 ElevenLabs characters", () => {
    const cost = estimateCallCost(3, "elevenlabs");
    expect(cost.assistantCents).toBe(15);
    expect(cost.telephonyCents).toBe(3);
    expect(cost.totalCents).toBe(18);
    expect(cost.elevenLabsChars).toBe(2400);
  });

  it("a Telnyx-voice call costs no ElevenLabs characters", () => {
    const cost = estimateCallCost(1, "telnyx");
    expect(cost.totalCents).toBe(6);
    expect(cost.elevenLabsChars).toBeNull();
  });

  it("a partial minute rounds up to a whole minute", () => {
    expect(estimateCallCost(1.2, "telnyx").totalCents).toBe(12);
  });
});

describe("fixed phrases (natural sound: full sentences, never fragments)", () => {
  it("the greeting, voicemail, and closing are complete sentences", () => {
    expect(buildCallGreeting("Marcus", "an ETA check on Trip 1903")).toBe(
      "Hi Marcus, this is Abel calling from Road to Legacy Trucking about an ETA check on Trip 1903.",
    );
    expect(buildVoicemailMessage("an ETA check on Trip 1903", "+15552345678")).toBe(
      "Hi, this is Abel calling from Road to Legacy Trucking about an ETA check on Trip 1903. Please call us back at (555) 234-5678. Thanks.",
    );
    expect(CALL_CLOSING_LINE).toBe("Thanks, I'll pass that along.");
  });
});

describe("formatCallTime", () => {
  it("prints Eastern time with its zone label, never UTC", () => {
    const text = formatCallTime("2026-11-17T15:30:00.000Z");
    expect(text).toContain("ET");
    expect(text).not.toContain("UTC");
  });
});
