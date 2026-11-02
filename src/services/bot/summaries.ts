// Lane 2 (Abel Intelligence Upgrade, Phase B) — rolling weekly
// conversation summaries (design §3.3). One summary per week,
// built from that week's raw turns, each row carrying the source
// turn ids. Summaries AUGMENT the timeline: raw turns are never
// deleted or replaced, and the summary is injected into context
// only alongside the verbatim recent window, so turn 21+ degrades
// into a sourced summary instead of into nothing.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface SummaryTurn {
  id: string;
  role: string;
  text: string;
  created_at: string;
}

/** Monday (UTC date) of the week containing the given instant - the conversation_summaries.week_start key. */
export function weekStartOf(instant: Date): string {
  const d = new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = (day + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

export type SummarizeTurns = (turns: SummaryTurn[]) => Promise<string>;

const MAX_TURNS_PER_SUMMARY = 200;

/**
 * Rebuilds the summary for each of the last two weeks that has
 * turns (current week + the one before it), when the stored
 * summary is missing or older than the week's newest turn.
 * Returns how many summaries were refreshed. Graceful absence:
 * before migration 00032 the table doesn't exist - returns 0.
 */
export async function refreshConversationSummaries(
  client: SupabaseClient,
  companyId: string,
  summarize: SummarizeTurns,
  now: Date = new Date(),
): Promise<number> {
  const weeks = [weekStartOf(now), weekStartOf(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000))];
  let refreshed = 0;

  for (const weekStart of weeks) {
    const weekEnd = new Date(`${weekStart}T00:00:00.000Z`);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

    const { data: turns, error: turnsError } = await client
      .from("telegram_messages")
      .select("id, role, text, created_at")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .gte("created_at", `${weekStart}T00:00:00.000Z`)
      .lt("created_at", weekEnd.toISOString())
      .order("created_at", { ascending: true })
      .limit(MAX_TURNS_PER_SUMMARY);
    if (turnsError) throw new Error(turnsError.message);
    const rows = (turns ?? []) as SummaryTurn[];
    if (rows.length === 0) continue;

    const { data: existing, error: existingError } = await client
      .from("conversation_summaries")
      .select("id, updated_at")
      .eq("company_id", companyId)
      .eq("week_start", weekStart)
      .is("deleted_at", null)
      .maybeSingle();
    if (existingError) {
      if (/conversation_summaries/.test(existingError.message) && /does not exist|could not find/i.test(existingError.message)) {
        return refreshed;
      }
      throw new Error(existingError.message);
    }
    const newestTurnAt = rows[rows.length - 1]!.created_at;
    if (existing && (existing as { updated_at: string }).updated_at >= newestTurnAt) continue;

    const summary = await summarize(rows);
    const { error: upsertError } = await client.from("conversation_summaries").upsert(
      {
        company_id: companyId,
        week_start: weekStart,
        summary,
        source_message_ids: rows.map((row) => row.id),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "company_id,week_start" },
    );
    if (upsertError) throw new Error(upsertError.message);
    refreshed += 1;
  }
  return refreshed;
}

/** The production summarizer prompt: decisions, facts, open threads, numbers - with names and dates kept literal. */
export function buildSummaryPrompt(turns: SummaryTurn[]): { system: string; user: string } {
  return {
    system:
      "You compress one week of a truck driver's conversations with his assistant into a durable summary. " +
      "Keep: decisions made, facts stated (names, places, numbers, dates - copied literally), open threads and promises, " +
      "and anything he corrected. Drop: small talk, repeated questions, and anything already phrased as a standing instruction. " +
      "Plain sentences, one per line, no invention - if it wasn't said, it isn't in the summary.",
    user: turns.map((t) => `${t.created_at.slice(0, 10)} ${t.role}: ${t.text}`).join("\n"),
  };
}
