// Frontier 2 — Telegram /model: the "What I know about you"
// read affordance.
//
// NO-COMMANDS TENSION (standing rule: "NO COMMANDS EVER — intent
// is inferred from conversation"): /model is NOT a command system.
// These are intent triggers — the owner asking, in words or with
// the one conventional slash-form, to see his model — handled in
// code as a read, exactly like "remember:" capture is handled in
// code today. No new command framework, no command registry, no
// other slash-forms are added here; anything else goes to the
// agent turn as conversation. Correct-by-reply likewise infers
// intent from his words ("correct lesson 2: ...") and STAGES the
// correction as a proposal — it never auto-applies.
//
// Quiet-hours / deliveryDecision are untouched: a /model reply
// answers his message, it is never proactive.

import { formatWhatIKnowText } from "@/services/bot/what-i-know";
import type { TelegramStore } from "./store";

const READ_PHRASES = ["what do you know about me", "show me my model", "show me what you know"];

/** True when this message asks to see his model. */
export function isModelReadRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[?.!]+$/u, "").trim();
  if (normalized === "/model") return true;
  return READ_PHRASES.includes(normalized);
}

export interface ModelCorrection {
  /** 1-based lesson number as shown in the /model reply. */
  lessonNumber: number;
  lesson: string;
}

const CORRECTION_PATTERNS = [
  /^(?:correct|fix|change)\s+(?:lesson\s+)?(\d+)\s*[:,\-–]\s*(.+)$/i,
  /^lesson\s+(\d+)\s+is\s+wrong\s*[:,]?\s*(.+)$/i,
  /^(\d+)\s+is\s+wrong\s*[:,]?\s*(.+)$/i,
];

/** Parses a correct-by-reply message, or null when it isn't one. */
export function parseModelCorrection(text: string): ModelCorrection | null {
  const trimmed = text.trim();
  for (const pattern of CORRECTION_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match) {
      const lessonNumber = Number.parseInt(match[1]!, 10);
      const lesson = (match[2] ?? "").trim();
      if (Number.isFinite(lessonNumber) && lessonNumber >= 1 && lesson.length > 0) {
        return { lessonNumber, lesson };
      }
    }
  }
  return null;
}

/** Renders the model read, or an honest fallback when the store has no model surface. */
export async function handleModelRead(store: TelegramStore | null): Promise<string> {
  if (!store?.getWhatIKnow) {
    return "I can't show you that yet — the model view isn't configured on this chat. It works in the app under More → What Abel remembers.";
  }
  try {
    const model = await store.getWhatIKnow();
    return formatWhatIKnowText(model);
  } catch (err) {
    console.error("[telegram] /model read failed", err);
    return "I couldn't pull up what I know about you just now — nothing was changed. Try again in a moment.";
  }
}

export interface ModelCorrectionResult {
  handled: boolean;
  reply: string;
}

/**
 * Correct-by-reply: his reply naming a lesson number stages the
 * superseding correction as a proposal (his yes executes it, his
 * no drops it). Never auto-applies. A number with no matching
 * lesson gets a plain answer naming how many lessons there are.
 */
export async function handleModelCorrection(
  store: TelegramStore | null,
  text: string,
  options: { writesRefused?: boolean } = {},
): Promise<ModelCorrectionResult> {
  const parsed = parseModelCorrection(text);
  if (!parsed) return { handled: false, reply: "" };
  if (options.writesRefused) {
    return {
      handled: true,
      reply:
        "I couldn't stage that correction this turn — a storage hiccup kept me from verifying the message wasn't a duplicate, so nothing was recorded. Say it again in a moment.",
    };
  }
  if (!store?.getWhatIKnow || !store.stageLessonCorrection) {
    return {
      handled: true,
      reply: "I can't stage lesson corrections on this chat yet — the model view isn't configured here. It works in the app under More → What Abel remembers.",
    };
  }
  try {
    const model = await store.getWhatIKnow();
    const target = model.lessons[parsed.lessonNumber - 1];
    if (!target) {
      return {
        handled: true,
        reply: `I only have ${model.lessons.length} ${model.lessons.length === 1 ? "lesson" : "lessons"} to correct — there is no lesson ${parsed.lessonNumber}. Send /model to see them numbered, then tell me which one and what's right.`,
      };
    }
    await store.stageLessonCorrection(target.id, parsed.lesson);
    return {
      handled: true,
      reply: `Staged for your yes — lesson ${parsed.lessonNumber} would change to: "${parsed.lesson}". Reply YES to record it, or NO to drop it. Nothing is changed until you say yes.`,
    };
  } catch (err) {
    console.error("[telegram] /model correction staging failed", err);
    return {
      handled: true,
      reply: "That correction didn't get staged — something went wrong storing it. Nothing was changed; try again in a moment.",
    };
  }
}
