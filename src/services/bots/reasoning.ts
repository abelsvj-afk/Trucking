// Shared reasoning access for the bot team (owner rule 2026-11-19:
// every bot gets the SAME reasoning Abel has — same brain, different
// jobs/tools; sharing the reasoning must never leak another bot's
// tools).
//
// INTERIM. The shared-reasoning engine (branch
// feat/shared-reasoning-2026-11-19, not on the remote yet) is the
// permanent home for this list. Until it lands, the list lives in
// Abel's own prompt (services/bot/agent-turn.ts) and this module is a
// thin re-export: every bot imports the forms from here, and when the
// engine lands the ONLY change is this file's import — no bot's
// instructions change shape. Do not edit block text here; do not copy
// the blocks into a bot module (a copy would drift from Abel's).
//
// What this covers: the fourteen reasoning forms in Abel's prompt
// today (nine from the 2026-11-10 reasoning layer, PR #59, plus the
// five Frontier-1 forms). The brief says "ten"; the prompt carries
// fourteen, so all fourteen are wired and none is dropped — the engine
// reconciles the count when it lands. NOT covered here (separate
// pieces of the same owner order, owned by the shared-reasoning
// crew): the three-path memory and the corrections-learning loop.
// A bot's tools, job, and memory stay its own — only the reasoning is
// shared.

import { ABEL_REASONING_BLOCKS, type ReasoningForm } from "@/services/bot/agent-turn";

export type { ReasoningForm };

/** Every reasoning form Abel has, verbatim, in prompt order. */
export const SHARED_REASONING_BLOCKS: ReasoningForm[] = ABEL_REASONING_BLOCKS;

/** The form names, in prompt order — the checklist a bot proves against. */
export const SHARED_REASONING_FORMS: string[] = SHARED_REASONING_BLOCKS.map((block) => block.form);

/**
 * The reasoning blocks as group-turn instructions. The webhook maps
 * every non-"fact" kind to an "instruction" in the model prompt, so
 * kind "reasoning" lands as a standing instruction — the same channel
 * Abel's group turn already uses for stored memories.
 */
export function reasoningInstructions(): { kind: string; content: string }[] {
  return SHARED_REASONING_BLOCKS.map((block) => ({
    kind: "reasoning",
    content: `REASONING — ${block.form}: ${block.text}`,
  }));
}
