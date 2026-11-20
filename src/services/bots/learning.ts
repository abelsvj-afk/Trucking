// Corrections-learning for the bot team — the same learning Abel got
// in v96 (services/bot/correction-watchouts.ts), carried to every bot
// through the shared brain.
//
// How it works, mirroring Abel exactly:
// - Every correction the owner makes to a bot's work is recorded as a
//   memory row of kind "correction" whose content is Abel's own
//   summary format ("corrected fields: rate, delivery_city") — the
//   format is shared, so a correction means the same thing for every
//   bot.
// - A field corrected at least WATCHOUT_THRESHOLD (2) times becomes a
//   WATCH-OUT: a durable kind "watch-out" memory row for that bot, and
//   a block in the bot's turn context, so a misread the owner already
//   caught twice gets double-checked — or asked about — instead of
//   repeated a third time.
// - The counting itself is Abel's code (correctedFields /
//   correctionWatchoutsBlock from services/bot/correction-watchouts),
//   fed through an adapter — not a copy that could drift.
//
// Per-bot by construction: rows are always read and written under one
// bot's slug, so Scout's corrections never become Billing's watch-outs.
// The reasoning is shared; the lessons stay in the seat that earned
// them.

import { correctedFields, correctionSummary, correctionWatchoutsBlock } from "@/services/bot/correction-watchouts";
import type { OutcomeRow } from "@/services/bot/learning";
import type { BotSlug } from "./registry";
import type { BotMemoryRow, BotTeamStore } from "./store";

/** The correction rows of one bot, in Abel's outcome shape for the shared counting code. */
export function correctionOutcomes(rows: BotMemoryRow[]): OutcomeRow[] {
  return rows
    .filter((row) => row.kind === "correction")
    .map((row) => ({
      tool_name: "bot-team",
      signature: "correction",
      outcome: "corrected" as const,
      summary: row.content,
      created_at: row.created_at,
    }));
}

/** Fields this bot has been corrected on at least twice, most-corrected first. Abel's counting, verbatim. */
export function botCorrectedFields(rows: BotMemoryRow[]): { field: string; count: number }[] {
  return correctedFields(correctionOutcomes(rows));
}

/**
 * The WATCH-OUTS context block for one bot, or null when no field has
 * crossed the threshold yet. Rendered by Abel's own block builder, so
 * every bot's watch-outs read exactly like Abel's.
 */
export function botWatchoutsBlock(rows: BotMemoryRow[]): string | null {
  return correctionWatchoutsBlock(correctionOutcomes(rows));
}

/** The stored watch-out row's content for one field — the prefix is the dedupe key. */
export function watchoutContent(field: string, count: number): string {
  return `${field}: corrected ${count} times — double-check it against the source before using it, or ask him for the value instead of guessing.`;
}

export interface RecordCorrectionResult {
  /** Fields that crossed the watch-out threshold with THIS correction and got a stored watch-out row. */
  newWatchouts: { field: string; count: number }[];
}

/**
 * Record one owner correction for a bot and derive any new watch-out.
 * The correction row is always written; a watch-out row is written
 * once per field, the first time its count reaches the threshold.
 * Throws on store failure — the caller decides how to surface it (no
 * silent failures), but a learning failure must never break a turn,
 * so callers should catch and log.
 */
export async function recordBotCorrection(
  store: BotTeamStore,
  botSlug: BotSlug,
  fields: string[],
  source = "owner-correction",
): Promise<RecordCorrectionResult> {
  const unique = [...new Set(fields.map((f) => f.trim()).filter(Boolean))];
  if (unique.length === 0) return { newWatchouts: [] };

  const before = botCorrectedFields(await store.loadBotMemories(botSlug));
  const beforeFields = new Set(before.map((f) => f.field));

  await store.saveBotMemory({
    botSlug,
    kind: "correction",
    content: correctionSummary(unique),
    source,
  });

  const rows = await store.loadBotMemories(botSlug);
  const after = botCorrectedFields(rows);
  const storedWatchouts = new Set(
    rows.filter((row) => row.kind === "watch-out").map((row) => row.content.split(":")[0]),
  );

  const newWatchouts: { field: string; count: number }[] = [];
  for (const { field, count } of after) {
    if (beforeFields.has(field) || storedWatchouts.has(field)) continue;
    await store.saveBotMemory({
      botSlug,
      kind: "watch-out",
      content: watchoutContent(field, count),
      source: "corrections-learning",
    });
    newWatchouts.push({ field, count });
  }
  return { newWatchouts };
}
