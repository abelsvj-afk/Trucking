// Shared reasoning, one brain (owner rule 2026-11-19: all bots get
// the same reasoning, wisdom, and smartness Abel has — same brain,
// different jobs/tools; sharing the reasoning must never leak another
// bot's tools).
//
// The ten reasoning forms Abel was promised (owner GO 2026-11-10,
// plus temporal 2026-11-07) live in services/bot/agent-turn.ts as
// the single source of truth. This module does NOT copy their text:
// it imports the blocks and assembles them for any bot. If a block's
// text changes in agent-turn, every bot's reasoning changes with it —
// there is no fork to drift.
//
// The five "think deeper" Frontier 1 blocks (owner GO 2026-11-11)
// and the learning mechanism (owner 2026-11-07) are Abel's reasoning
// too, so they are shared as well — itemised separately below, never
// silently dropped. Count today: 10 required forms + 5 Frontier 1 +
// 1 learning mechanism = 16 shared blocks.
//
// REBASE NOTE: a separate crew is wiring this reasoning into a
// shared engine on branch feat/shared-reasoning-2026-11-19. When
// that merge lands, re-point the imports below at the engine module
// (one import change); the form ids, the Auditor overlay, and the
// tests here stay the same. Until then this adapter IS the shared
// interface, sourced from agent-turn.ts.
//
// SCOPING: the shared blocks are written for Abel, so some name
// Abel's write tools (set_load_stops, save_memory, find_more_tools).
// The Auditor overlay below is read FIRST and overrides those
// mechanics for Auditor: same reasoning, scoped tools. The overlay
// never edits the shared text — it qualifies it. The per-bot tool
// gateway (registry.visibleToolGroups) is what enforces the scope in
// code; the overlay is what tells the model.

import {
  CAUSAL_RULES,
  CHAINED_REASONING_RULES,
  CONSOLIDATION_RULES,
  CONTEXTUAL_RULES,
  EPISODIC_RULES,
  LEARNING_RULES,
  PREDICTION_RULES,
  RESTRAINT_RULES,
  SELF_CORRECTION_RULES,
  TEMPORAL_RULES,
  THEORY_OF_MIND_RULES,
  TOOL_SELECTION_RULES,
  TRADEOFF_RULES,
  UNCERTAINTY_RULES,
  VALUE_LEARNING_RULES,
  VERIFICATION_RULES,
} from "@/services/bot/agent-turn";

export type ReasoningFormId =
  | "temporal"
  | "contextual"
  | "causal"
  | "practical"
  | "self-correction"
  | "episodic"
  | "theory-of-mind"
  | "value-learning"
  | "consolidation"
  | "restraint"
  | "chained"
  | "verification"
  | "uncertainty"
  | "tradeoff"
  | "prediction"
  | "learning";

export interface ReasoningForm {
  id: ReasoningFormId;
  /** The form's name as the owner knows it. */
  name: string;
  /** A distinctive marker phrase from the shared text, for tests. */
  marker: string;
  /** The shared block text, verbatim from agent-turn.ts. */
  text: string;
}

/**
 * The ten reasoning forms (owner GO 2026-11-10 + temporal
 * 2026-11-07). "Practical" lives inside TOOL_SELECTION_RULES as
 * its PRACTICAL sentence — the form is the tool-selection block.
 */
export const TEN_REASONING_FORMS: ReasoningForm[] = [
  { id: "temporal", name: "temporal", marker: "TIME: never work out a weekday", text: TEMPORAL_RULES },
  { id: "contextual", name: "contextual", marker: "CONTEXT: hold the whole thread", text: CONTEXTUAL_RULES },
  { id: "causal", name: "causal", marker: "CAUSE BEFORE CONCLUSION", text: CAUSAL_RULES },
  { id: "practical", name: "practical", marker: "PRACTICAL: fit the action to the moment", text: TOOL_SELECTION_RULES },
  { id: "self-correction", name: "self-correction", marker: "OWN YOUR MISTAKES", text: SELF_CORRECTION_RULES },
  { id: "episodic", name: "episodic", marker: "EPISODES, NOT JUST FACTS", text: EPISODIC_RULES },
  { id: "theory-of-mind", name: "theory of mind (first-order)", marker: "WHAT HE KNOWS", text: THEORY_OF_MIND_RULES },
  { id: "value-learning", name: "value learning", marker: "LEARN WHAT HE VALUES FROM WHAT HE DOES", text: VALUE_LEARNING_RULES },
  { id: "consolidation", name: "consolidation", marker: "USE WHAT YOU ALREADY LEARNED", text: CONSOLIDATION_RULES },
  { id: "restraint", name: "restraint (knowing when to shut up)", marker: "KNOW WHEN TO STOP", text: RESTRAINT_RULES },
];

/** "Think deeper" Frontier 1 (owner GO 2026-11-11). Also shared. */
export const FRONTIER_REASONING_FORMS: ReasoningForm[] = [
  { id: "chained", name: "chained reasoning", marker: "PLAN THEN ACT", text: CHAINED_REASONING_RULES },
  { id: "verification", name: "self-verification", marker: "CHECK BEFORE YOU SEND", text: VERIFICATION_RULES },
  { id: "uncertainty", name: "honest uncertainty", marker: "SAY WHAT YOU DON'T KNOW", text: UNCERTAINTY_RULES },
  { id: "tradeoff", name: "trade-off math", marker: "SHOW BOTH SIDES OF THE MATH", text: TRADEOFF_RULES },
  { id: "prediction", name: "causal prediction", marker: "FORECAST, DON'T BLOCK", text: PREDICTION_RULES },
];

/** Outcome learning (owner 2026-11-07): a supporting mechanism, not one of the ten. Also shared. */
export const LEARNING_FORM: ReasoningForm = {
  id: "learning",
  name: "learning from answers",
  marker: "LEARNING: the 'WHAT HE HAS TOLD YOU BY ANSWERING' block",
  text: LEARNING_RULES,
};

/** Every shared block: the ten forms, the five Frontier 1 forms, and learning. */
export const ALL_SHARED_REASONING_FORMS: ReasoningForm[] = [
  ...TEN_REASONING_FORMS,
  ...FRONTIER_REASONING_FORMS,
  LEARNING_FORM,
];

export function reasoningFormById(id: ReasoningFormId): ReasoningForm | undefined {
  return ALL_SHARED_REASONING_FORMS.find((form) => form.id === id);
}

/** The shared reasoning text, forms joined in order. Same for every bot. */
export function sharedReasoningText(): string {
  return ALL_SHARED_REASONING_FORMS.map((form) => form.text).join("\n\n");
}

/**
 * How the shared reasoning reads for the Auditor. Read FIRST, before
 * the shared blocks: it overrides every Abel-specific mechanic the
 * Auditor must not follow, because the Auditor has no write tools
 * and no calls. Nothing here edits the shared text — it qualifies it.
 *
 * - Self-correction: name the error plainly, then FLAG the
 *   correction for the owner or the owning bot. Never fix a record
 *   yourself — you have no write tools, and a silent fix is the
 *   thing you exist to prevent.
 * - Value learning / learning: a correction that reveals a standing
 *   preference is flagged, not saved — you have no save_memory.
 *   The owner or Abel saves it; you note the conflict either way.
 * - Practical / tool selection: you have no find_more_tools and no
 *   write tools to pull in. Use the fewest READ calls that settle
 *   the check; never run a write when a read answers it — you have
 *   no writes at all. If a tool you need is not in front of you,
 *   say "cannot verify" and name what is missing.
 * - Verification: your check IS the verification pass — recompute
 *   in code (services/bots/auditor.ts) before you speak, and show
 *   both numbers where they disagree.
 * - Uncertainty: "cannot verify" is your answer whenever the source
 *   is missing or unclear — name exactly what would settle it.
 * - Restraint: a check that passes is one line ("checks out") or
 *   silence. Never pad a flag with a lecture.
 * - Theory of mind: model only the owner's knowledge and worries —
 *   never a broker's, dispatcher's, or another bot's inner state.
 * - Prediction: a forecast is advisory text only, labeled "at this
 *   pace" — it never blocks a draft or a decision.
 * - Phrasing drift is a reasoning job, not arithmetic: when a bot
 *   describes the same kind of thing in a different way than
 *   before, name what changed and ask which wording is right.
 */
export const AUDITOR_REASONING_OVERLAY =
  "AUDITOR READING OF THE SHARED REASONING (read this first — it overrides the Abel-specific mechanics below, which name tools you do not have): " +
  "You are the Auditor: read-only everywhere, flag only. You have NO write tools and NO calls, and you never fix a record yourself — a silent fix is the thing you exist to prevent. " +
  "SELF-CORRECTION, AUDITOR READING: when you were wrong, name the error plainly in your first sentence, then FLAG the correction for the owner or the owning bot — never fix it yourself. " +
  "VALUE LEARNING and LEARNING, AUDITOR READING: when a correction reveals a standing preference, FLAG it so the owner or Abel can save it — you have no save_memory, and a standing preference is never updated silently. Your flags are what you learn from: what the owner accepts or dismisses teaches you what to flag next, and you suggest less of what he keeps turning down. " +
  "PRACTICAL, AUDITOR READING: fit the check to the moment, use the fewest READ calls that settle it, and never run a write when a read answers it — you have no writes at all. If a tool you need is not in front of you, say 'cannot verify' and name what is missing. " +
  "VERIFICATION, AUDITOR READING: your check IS the verification pass — recompute the numbers in code before you speak, and show both numbers where they disagree. " +
  "UNCERTAINTY, AUDITOR READING: 'cannot verify' is your answer whenever the source is missing or unclear — name exactly what would settle it. " +
  "RESTRAINT, AUDITOR READING: a check that passes is one line ('checks out') or silence. Never pad a flag with a lecture. " +
  "PHRASING DRIFT: when a bot describes the same kind of thing in a different way than it did before, name what changed and ask which wording is right — that is a reasoning job, not arithmetic, and it is yours. " +
  "THEORY OF MIND, AUDITOR READING: model only the owner's knowledge and worries — never a broker's, dispatcher's, or another bot's inner state. " +
  "PREDICTION, AUDITOR READING: a forecast is advisory text only, labeled 'at this pace' — it never blocks a draft or a decision.";

/**
 * The Auditor's reasoning prompt: the scope overlay first, then all
 * sixteen shared blocks verbatim. All ten required forms are in
 * here, plus the five Frontier 1 forms and the learning mechanism —
 * none dropped, none silently cut down.
 */
export function buildAuditorReasoningPrompt(): string {
  return `${AUDITOR_REASONING_OVERLAY}\n\n${sharedReasoningText()}`;
}

/**
 * The shared reasoning prompt for any bot: the shared blocks, plus
 * that bot's scope overlay when one exists. Auditor is the only bot
 * with an overlay today; other bots get the shared text verbatim
 * until their crews add theirs.
 */
export function buildSharedReasoningPrompt(botSlug: string): string {
  if (botSlug === "auditor") return buildAuditorReasoningPrompt();
  return sharedReasoningText();
}
