import { describe, expect, it } from "vitest";
import { createSpeaker, type SpeechSynthLike } from "@/lib/drive-speech";
import { DRIVE_MUTED_STORAGE_KEY } from "@/lib/drive";

class FakeSynth implements SpeechSynthLike {
  spoken: { text: string; rate: number }[] = [];
  cancels = 0;
  speak(utterance: SpeechSynthesisUtterance): void {
    this.spoken.push({ text: utterance.text, rate: utterance.rate });
  }
  cancel(): void {
    this.cancels += 1;
  }
}

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Pick<Storage, "getItem" | "setItem">;
  return { storage, map };
}

function makeSpeaker(initial: Record<string, string> = {}) {
  const synth = new FakeSynth();
  const { storage, map } = fakeStorage(initial);
  const speaker = createSpeaker({
    synth,
    storage,
    createUtterance: (text) =>
      ({ text, rate: 1 }) as unknown as SpeechSynthesisUtterance,
  });
  return { speaker, synth, map };
}

describe("createSpeaker", () => {
  it("speaks at rate 0.95 and cancels whatever was in flight (G-6)", () => {
    const { speaker, synth } = makeSpeaker();
    speaker.speak("First line.");
    speaker.speak("Second line.");
    expect(synth.cancels).toBe(2);
    expect(synth.spoken).toEqual([
      { text: "First line.", rate: 0.95 },
      { text: "Second line.", rate: 0.95 },
    ]);
  });

  it("blank text is a no-op, not a cancel", () => {
    const { speaker, synth } = makeSpeaker();
    speaker.speak("");
    speaker.speak("   ");
    expect(synth.spoken).toHaveLength(0);
    expect(synth.cancels).toBe(0);
  });

  it("mute persists under the D1 key and silences speech until unmuted", () => {
    const { speaker, synth, map } = makeSpeaker();
    expect(speaker.isMuted()).toBe(false);
    speaker.setMuted(true);
    expect(map.get(DRIVE_MUTED_STORAGE_KEY)).toBe("1");
    speaker.speak("Should not be heard.");
    expect(synth.spoken).toHaveLength(0);
    speaker.setMuted(false);
    speaker.speak("Heard again.");
    expect(synth.spoken).toHaveLength(1);
  });

  it("a stored mute is honored by a fresh speaker (persisted toggle)", () => {
    const { speaker, synth } = makeSpeaker({ [DRIVE_MUTED_STORAGE_KEY]: "1" });
    expect(speaker.isMuted()).toBe(true);
    speaker.speak("Muted from last time.");
    expect(synth.spoken).toHaveLength(0);
  });

  it("stop() cancels in-flight speech", () => {
    const { speaker, synth } = makeSpeaker();
    speaker.speak("Something.");
    speaker.stop();
    expect(synth.cancels).toBe(2);
  });
});
