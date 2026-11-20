// The shared brain: Abel's full reasoning, carried by every bot on
// the team (owner rule, 2026-11-19: "all bots get the same reasoning,
// wisdom, and smartness Abel has — same brain, different jobs/tools;
// sharing the reasoning must never leak another bot's tools").
//
// What "shared" means in code:
// - The reasoning FORMS are Abel's own rule blocks, imported from the
//   one source of truth (services/bot/reasoning-forms.ts) — the same
//   strings Abel's 1:1 prompt assembles. There is no second copy to
//   drift. A form fixed there changes for Abel and every bot at once.
// - The MEMORY is per-bot: each bot reads and writes only its own
//   bot_team_memories rows (services/bots/store.ts), and the context
//   builder below renders one bot's rows — never another bot's.
// - The TOOLS stay scoped per bot (services/bots/registry.ts): the
//   prompt names exactly the tool groups this bot may see, and says
//   the rest do not exist for it. Reasoning crosses seats; tools and
//   memory never do.
// - The guardrails stay propose-only (services/bots/guardrails.ts):
//   the prompt states the rule, the gate enforces it in code.
//
// The ten core forms (owner GO 2026-11-10, temporal 2026-11-07):
// temporal, contextual, causal, practical, self-correction, episodic,
// theory of mind, value learning, consolidation, restraint.
// The five think-deeper forms (Frontier 1, owner GO 2026-11-11):
// chained reasoning, self-verification, honest uncertainty,
// trade-off math, causal prediction.
// All fifteen are assembled for every bot, in Abel's own order —
// no cut-down version for any seat.

import {
  CAUSAL_RULES,
  CHAINED_REASONING_RULES,
  CONSOLIDATION_RULES,
  CONTEXTUAL_RULES,
  EPISODIC_RULES,
  PRACTICAL_RULES,
  PREDICTION_RULES,
  RESTRAINT_RULES,
  SELF_CORRECTION_RULES,
  TEMPORAL_RULES,
  THEORY_OF_MIND_RULES,
  TRADEOFF_RULES,
  UNCERTAINTY_RULES,
  VALUE_LEARNING_RULES,
  VERIFICATION_RULES,
} from "@/services/bot/reasoning-forms";
import { botCorrectedFields, botWatchoutsBlock } from "./learning";
import { botIdentity, isBotSlug, toolScopeFor, visibleToolGroups, type BotSlug, type ToolGroup } from "./registry";
import type { BotMemoryRow } from "./store";

export interface ReasoningForm {
  id: string;
  /** The form's name, as the owner knows it. */
  name: string;
  layer: "core" | "think-deeper";
  /** The rule block itself — Abel's text, shared verbatim. */
  rules: string;
}

export const REASONING_FORMS: ReasoningForm[] = [
  { id: "temporal", name: "Temporal", layer: "core", rules: TEMPORAL_RULES },
  { id: "contextual", name: "Contextual", layer: "core", rules: CONTEXTUAL_RULES },
  { id: "causal", name: "Causal", layer: "core", rules: CAUSAL_RULES },
  { id: "practical", name: "Practical", layer: "core", rules: PRACTICAL_RULES },
  { id: "self-correction", name: "Self-correction", layer: "core", rules: SELF_CORRECTION_RULES },
  { id: "episodic", name: "Episodic", layer: "core", rules: EPISODIC_RULES },
  { id: "theory-of-mind", name: "Theory of mind (first-order)", layer: "core", rules: THEORY_OF_MIND_RULES },
  { id: "value-learning", name: "Value learning", layer: "core", rules: VALUE_LEARNING_RULES },
  { id: "consolidation", name: "Consolidation", layer: "core", rules: CONSOLIDATION_RULES },
  { id: "restraint", name: "Restraint (knowing when to stop)", layer: "core", rules: RESTRAINT_RULES },
  { id: "chained", name: "Chained reasoning", layer: "think-deeper", rules: CHAINED_REASONING_RULES },
  { id: "self-verification", name: "Self-verification", layer: "think-deeper", rules: VERIFICATION_RULES },
  { id: "honest-uncertainty", name: "Honest uncertainty", layer: "think-deeper", rules: UNCERTAINTY_RULES },
  { id: "trade-off-math", name: "Trade-off math", layer: "think-deeper", rules: TRADEOFF_RULES },
  { id: "causal-prediction", name: "Causal prediction", layer: "think-deeper", rules: PREDICTION_RULES },
];

/** Every form's rule block, joined in Abel's assembly order. The whole brain, nothing trimmed. */
export function sharedReasoningPrompt(): string {
  return REASONING_FORMS.map((form) => form.rules).join("\n\n");
}

const GROUP_LABELS: Record<ToolGroup, string> = {
  loads: "loads",
  hos: "hours (HOS)",
  money: "money",
  documents: "documents",
  email: "email",
  maps: "maps",
  "app-actions": "app actions",
  calls: "phone calls",
  signature: "signing documents",
};

/**
 * The tool-scope framing for one bot's prompt. It names ONLY the tool
 * groups this bot may see, with their scope levels — and states that
 * everything else does not exist for this bot. This is the prompt
 * half of the no-leak rule; the registry/gateway half hides the tools
 * themselves, so a bot cannot call what it cannot see, and is never
 * even told the other groups are there to want.
 */
export function toolScopeFraming(slug: BotSlug): string {
  const visible = visibleToolGroups(slug);
  const lines = visible.map((group) => `- ${GROUP_LABELS[group]}: ${toolScopeFor(slug, group)}`);
  return (
    "YOUR TOOLS — AND ONLY YOURS:\n" +
    lines.join("\n") +
    "\nTool groups not listed here do not exist for you: never offer, claim, or attempt an action in another bot's scope, and never describe another bot's tools as your own. " +
    "If a task needs a group you do not have, say which bot's job it is and hand it off in the group chat instead of reaching outside your scope."
  );
}

/** The propose-only framing every bot carries (the gate in guardrails.ts enforces the same rule in code). */
export const PROPOSE_ONLY_FRAMING =
  "PROPOSE, DON'T EXECUTE: you may read, draft, and flag on your own. Anything anyone outside the app would see — booking a load, sending a message, moving money, signing, placing a call outside an approved call plan — is a proposal first, and it waits for the owner's yes. An unanswered proposal is not a yes.";

/**
 * One bot's full system prompt: its own identity and seat, its own
 * tool scope, the propose-only rule, and the shared reasoning —
 * every form, unabridged. Returns null for an unknown slug: an
 * unrecognized bot gets no brain, never Abel's by accident.
 */
export function buildBotSystemPrompt(slug: string): string | null {
  if (!isBotSlug(slug)) return null;
  const identity = botIdentity(slug);
  const intro =
    `You are ${identity.displayName}, the owner's ${identity.seat}, one of the Road to Legacy bot team. ` +
    "You work for Sajacous, the owner-operator: he is the only decision-maker, and every bot on the team reports to Abel, the coordinator. " +
    "You share Abel's reasoning in full — the same forms below govern how you think — but your job, your tools, and your memory are your own seat's, and no other bot's.";
  return [intro, toolScopeFraming(slug), PROPOSE_ONLY_FRAMING, sharedReasoningPrompt()].join("\n\n");
}

/**
 * One bot's memory context: what THIS bot remembers, rendered for its
 * turn. Watch-outs (derived from its own corrections, plus any stored
 * watch-out rows) come first — they are the lessons that must change
 * behavior before anything else is read. Then its standing rules,
 * facts, and preferences. Correction rows themselves are not listed:
 * they are the raw material the watch-outs are derived from, and
 * listing them would double-count the lesson.
 *
 * The rows passed in must already be this bot's own (the store reads
 * per slug) — this builder never sees another bot's memory.
 */
export function buildBotMemoryContext(rows: BotMemoryRow[]): string {
  const parts: string[] = [];

  const derived = botWatchoutsBlock(rows);
  if (derived) parts.push(derived);

  // Stored watch-out rows whose field no longer derives (its
  // correction rows aged out of the load window) still stand — a
  // lesson earned is not un-earned by the raw rows scrolling away.
  const derivedFields = new Set(botCorrectedFields(rows).map((f) => f.field));
  const standingWatchouts = rows.filter(
    (row) => row.kind === "watch-out" && !derivedFields.has(row.content.split(":")[0] ?? ""),
  );
  if (standingWatchouts.length > 0) {
    parts.push(
      "WATCH-OUTS FROM HIS OWN CORRECTIONS:\n" + standingWatchouts.map((row) => `- ${row.content}`).join("\n"),
    );
  }

  const rules = rows.filter((row) => row.kind === "rule");
  if (rules.length > 0) {
    parts.push("YOUR STANDING RULES (his words, saved for your seat):\n" + rules.map((row) => `- ${row.content}`).join("\n"));
  }

  const remembered = rows.filter((row) => row.kind === "fact" || row.kind === "preference");
  if (remembered.length > 0) {
    parts.push(
      "WHAT YOU REMEMBER (your own memory — no other bot's memory is in here):\n" +
        remembered.map((row) => `- (${row.kind}) ${row.content}`).join("\n"),
    );
  }

  return parts.join("\n\n");
}
