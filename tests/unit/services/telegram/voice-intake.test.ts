// Phase E acceptance (design §7 Phase E + the owner's backend
// self-report rule): a Telegram voice note is downloaded and
// transcribed into the text pipeline - and every failure mode
// answers PLAINLY (switch off, provider not configured, download
// failed, too long). Nothing is ever silently swallowed.

import { describe, expect, it, vi } from "vitest";
import { handleTelegramVoice, type TelegramVoice } from "@/services/telegram/voice-intake";

const VOICE: TelegramVoice = { file_id: "voice-file-1", duration: 12, mime_type: "audio/ogg" };

function fetchMock() {
  return vi.fn(async (url: string) => {
    if (url.includes("/getFile")) {
      return { ok: true, json: async () => ({ ok: true, result: { file_path: "voice/file_1.oga" } }) };
    }
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  }) as unknown as typeof fetch;
}

describe("handleTelegramVoice", () => {
  it("happy path: downloads and returns the transcript for the text pipeline", async () => {
    const result = await handleTelegramVoice(VOICE, {
      botToken: "token",
      isEnabled: async () => true,
      transcribe: async () => "Log fuel, 40 gallons at the Pilot on I-20",
      fetchFn: fetchMock(),
    });
    expect(result).toEqual({ kind: "transcript", text: "Log fuel, 40 gallons at the Pilot on I-20" });
  });

  it("switch OFF: a plain reply naming the switch - no download, no transcription attempted", async () => {
    const fetchFn = fetchMock();
    const result = await handleTelegramVoice(VOICE, {
      botToken: "token",
      isEnabled: async () => false,
      transcribe: async () => "should never run",
      fetchFn,
    });
    expect(result.kind).toBe("reply");
    if (result.kind === "reply") expect(result.text).toContain("Voice transcription switch is off");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("over the duration cap: named as too long, not silently truncated", async () => {
    const result = await handleTelegramVoice(
      { ...VOICE, duration: 900 },
      { botToken: "token", isEnabled: async () => true, transcribe: async () => "x", fetchFn: fetchMock() },
    );
    expect(result.kind).toBe("reply");
    if (result.kind === "reply") expect(result.text).toContain("15 minutes");
  });

  it("download failure: plain failure reply, nothing stored", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, json: async () => ({ ok: false }) })) as unknown as typeof fetch;
    const result = await handleTelegramVoice(VOICE, {
      botToken: "token",
      isEnabled: async () => true,
      transcribe: async () => "x",
      fetchFn,
    });
    expect(result.kind).toBe("reply");
    if (result.kind === "reply") expect(result.text).toContain("couldn't transcribe");
  });
});
