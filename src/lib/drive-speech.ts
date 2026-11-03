// Drive Mode voice-out (G-6): a thin, honest wrapper over the
// browser's speechSynthesis. On-device voices, no data connection
// needed. The rules from the gate: new speech cancels in-flight
// speech (a queue of stale prompts is worse than one missed one),
// rate 0.95, and the mute toggle persists across sessions.
//
// The spoken SET is closed and lives in src/lib/drive.ts - this
// module only knows how to say a line, never which lines exist.

import { DRIVE_MUTED_STORAGE_KEY } from "./drive";

export interface SpeechSynthLike {
  speak(utterance: SpeechSynthesisUtterance): void;
  cancel(): void;
}

export interface Speaker {
  /** Speaks the line unless muted. Cancels whatever is in flight. */
  speak(text: string): void;
  /** Silences anything in flight immediately. */
  stop(): void;
  isMuted(): boolean;
  setMuted(muted: boolean): void;
}

interface SpeakerDeps {
  synth: SpeechSynthLike | null;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  createUtterance?: (text: string) => SpeechSynthesisUtterance;
}

export function createSpeaker(deps: SpeakerDeps): Speaker {
  const createUtterance =
    deps.createUtterance ??
    ((text: string) => new SpeechSynthesisUtterance(text));
  let muted = deps.storage?.getItem(DRIVE_MUTED_STORAGE_KEY) === "1";

  return {
    speak(text: string) {
      if (muted || !deps.synth || !text.trim()) return;
      deps.synth.cancel();
      const utterance = createUtterance(text);
      utterance.rate = 0.95;
      deps.synth.speak(utterance);
    },
    stop() {
      deps.synth?.cancel();
    },
    isMuted() {
      return muted;
    },
    setMuted(next: boolean) {
      muted = next;
      if (next) deps.synth?.cancel();
      try {
        deps.storage?.setItem(DRIVE_MUTED_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Private mode / storage full: mute stays session-local.
      }
    },
  };
}

/** The browser-backed speaker; null-safe where speechSynthesis
 * doesn't exist (older browsers, SSR) - Drive then just doesn't
 * talk, and the card still carries every fact visually. */
export function browserSpeaker(): Speaker {
  const synth =
    typeof window !== "undefined" && "speechSynthesis" in window
      ? window.speechSynthesis
      : null;
  const storage =
    typeof window !== "undefined" ? window.localStorage : null;
  return createSpeaker({ synth, storage });
}
