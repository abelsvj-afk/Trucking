// Bots' corrections-learning — Abel's mechanism, shared.
// Abel (services/bot/correction-watchouts.ts): a field fixed twice
// becomes a watch-out, and the watch-out is read into every turn.
// The bots learn the same way, from their own record: a denied
// load-draft proposal whose payload carries Auditor flags records
// one "correction"-kind memory per flagged field; the second
// correction of the same field writes a "watch-out"-kind memory.
// Both kinds are read into every turn below, so a bot that got a
// number wrong twice stops staging the same wrong number.
//
// The mechanism shape (outcomes -> watch-outs -> prompt) is the
// same as Abel's. The source differs: Abel learns from
// bot_proposal_outcomes; the bots learn from the audit log's
// denied proposals (this module) plus the load ledger
// (recordLoadOutcome, Phase 0). The nightly consolidation pass
// stays Abel-only for now (company-scoped, rides the research
// invoker; bots get watch-outs + outcomes in-context instead) —
// see docs/bot-team-shared-reasoning.md.

import type { BotSlug } from "./registry";
import type { BotMemoryRow, BotTeamStore, LoadLedgerRow } from "./store";

/** Abel's threshold (correction-watchouts.ts WATCHOUT_THRESHOLD): 2. */
export const BOT_WATCHOUT_THRESHOLD = 2;

export interface BotCorrectionInput {
  botSlug: BotSlug;
  /** The field the Auditor flagged, e.g. "pay". */
  field: string;
  /** What was wrong, in the flag's own words. */
  detail: string;
  /** Where the correction came from (proposal id). */
  sourceRef?: string | null;
}

function correctionContent(field: string, detail: string): string {
  return `field "${field}" — corrected: ${detail}`;
}

function watchoutContent(field: string): string {
  return `WATCH OUT: field "${field}" was corrected twice — double-check it against the source before staging a draft.`;
}

/**
 * Record one correction. A second correction of the same field
 * also writes the watch-out (once — a later correction of a field
 * that already has a watch-out does not write a second one).
 */
export async function recordBotCorrection(teamStore: BotTeamStore, input: BotCorrectionInput): Promise<void> {
  const memories = await teamStore.loadBotMemories(input.botSlug);
  const priorCorrections = memories.filter(
    (row) => row.kind === "correction" && row.content.startsWith(`field "${input.field}"`),
  ).length;
  await teamStore.saveBotMemory({
    botSlug: input.botSlug,
    kind: "correction",
    content: correctionContent(input.field, input.detail),
    source: input.sourceRef ?? "group-decision",
  });
  if (priorCorrections + 1 < BOT_WATCHOUT_THRESHOLD) return;
  const hasWatchout = memories.some(
    (row) => row.kind === "watch-out" && row.content.includes(`field "${input.field}"`),
  );
  if (hasWatchout) return;
  await teamStore.saveBotMemory({
    botSlug: input.botSlug,
    kind: "watch-out",
    content: watchoutContent(input.field),
    source: input.sourceRef ?? "group-decision",
  });
}

/** The bot's own memories as a context block (facts, rules, preferences). */
export function botMemoriesBlock(memories: BotMemoryRow[]): string | null {
  const kept = memories.filter((row) => row.kind === "fact" || row.kind === "rule" || row.kind === "preference");
  if (kept.length === 0) return null;
  const lines = kept.map((row) => `- [${row.kind}] ${row.content}`);
  return `WHAT YOU REMEMBER ABOUT THIS JOB:\n${lines.join("\n")}`;
}

/** Corrections + watch-outs as a context block — read into every turn. */
export function botWatchoutsBlock(memories: BotMemoryRow[]): string | null {
  const kept = memories.filter((row) => row.kind === "correction" || row.kind === "watch-out");
  if (kept.length === 0) return null;
  const lines = kept.map((row) => `- ${row.content}`);
  return `WATCH-OUTS FROM CORRECTIONS — fields you got wrong before, so check them against the source before staging:\n${lines.join("\n")}`;
}

/** Recent load outcomes as a context block (Scout's learning surface). */
export function recentOutcomesBlock(outcomes: LoadLedgerRow[]): string | null {
  if (outcomes.length === 0) return null;
  const lines = outcomes.map((row) => {
    const lane = [row.origin, row.destination].filter(Boolean).join(" → ") || row.load_ref;
    const pay = row.pay_cents !== null ? `$${(row.pay_cents / 100).toFixed(2)}` : "no pay recorded";
    return `- ${lane}: ${row.outcome}, ${pay}${row.broker_name ? `, broker ${row.broker_name}` : ""}${row.notes ? ` — ${row.notes}` : ""}`;
  });
  return `WHAT HAPPENED TO RECENT LOADS — learn from these outcomes when you price the next one:\n${lines.join("\n")}`;
}
