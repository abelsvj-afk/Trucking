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
  /**
   * His ElevenLabs voice (2026-11-19): a playable link for the line, or null
   * when there is none (not set up, monthly budget reached, offline) — then
   * the phone's own voice speaks it. Each line is generated once on the server
   * and saved; this side also remembers links, so a line is asked for once.
   */
  clip?: (text: string) => Promise<string | null>;
  play?: (url: string) => { stop: () => void; done: Promise<void> };
}

export function createSpeaker(deps: SpeakerDeps): Speaker {
  const createUtterance =
    deps.createUtterance ??
    ((text: string) => new SpeechSynthesisUtterance(text));
  let muted = deps.storage?.getItem(DRIVE_MUTED_STORAGE_KEY) === "1";
  let token = 0;
  let playing: { stop: () => void } | null = null;
  const sayWithPhone = (text: string) => {
    if (!deps.synth) return;
    const utterance = createUtterance(text);
    utterance.rate = 0.95;
    deps.synth.speak(utterance);
  };
  const stopAll = () => {
    deps.synth?.cancel();
    playing?.stop();
    playing = null;
  };

  return {
    speak(text: string) {
      if (muted || !text.trim()) return;
      if (!deps.synth && !(deps.clip && deps.play)) return;
      // New speech cancels in-flight speech (a stale prompt is worse than a missed one).
      stopAll();
      const mine = ++token;
      if (!deps.clip || !deps.play) {
        sayWithPhone(text);
        return;
      }
      const play = deps.play;
      deps
        .clip(text)
        .catch(() => null)
        .then((url) => {
          if (mine !== token || muted) return;
          if (!url) {
            sayWithPhone(text);
            return;
          }
          const p = play(url);
          playing = p;
          // A clip that won't play (offline, blocked) still gets said.
          p.done.catch(() => {
            if (mine === token && !muted) sayWithPhone(text);
          });
        });
    },
    stop() {
      token++;
      stopAll();
    },
    isMuted() {
      return muted;
    },
    setMuted(next: boolean) {
      muted = next;
      if (next) {
        token++;
        stopAll();
      }
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
  if (typeof window === "undefined" || typeof Audio === "undefined") return createSpeaker({ synth, storage });
  const links = new Map<string, { url: string | null; atMs: number }>();
  // Signed links last an hour; ask again after 50 minutes. A "no clip" answer is retried after 10.
  const clip = async (text: string): Promise<string | null> => {
    const hit = links.get(text);
    if (hit && Date.now() - hit.atMs < (hit.url ? 50 : 10) * 60_000) return hit.url;
    const res = await fetch("/api/v1/voice/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const url = res.ok ? (((await res.json()) as { data: { url: string | null } }).data.url ?? null) : null;
    links.set(text, { url, atMs: Date.now() });
    return url;
  };
  const play = (url: string) => {
    const audio = new Audio(url);
    const done = audio.play().then(
      () => new Promise<void>((resolve) => audio.addEventListener("ended", () => resolve(), { once: true })),
    );
    return { stop: () => audio.pause(), done };
  };
  return createSpeaker({ synth, storage, clip, play });
}
