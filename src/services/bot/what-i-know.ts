// Frontier 2 — "What I know about you": the inspectable model.
// Beliefs + preferences (current bot_memories, grouped) and
// lessons (current agent_episodes, each with its evidence).
// One loader + one text renderer shared by the app page
// (via /api/v1/what-i-know) and Telegram /model, so both surfaces
// always show the same model.
//
// Grouping rule (documented): beliefs are fact / business_fact /
// person_profile rows; preferences are instruction rows (standing
// instructions ARE his stated preferences for how Abel behaves);
// note / expense_hint rows are shown under "other" rather than
// hidden — the page never silently drops a stored row.

import type { SupabaseClient } from "@supabase/supabase-js";
import { listEpisodes, type EpisodeRow } from "./episodes";

export interface WhatIKnowEntry {
  id: string;
  kind: string;
  content: string;
  created_at: string;
  valid_to: string | null;
  superseded_by: string | null;
}

export interface WhatIKnowLesson extends EpisodeRow {
  /** The evidence behind the lesson — its situation text. */
  evidence: string | null;
}

export interface WhatIKnowModel {
  beliefs: WhatIKnowEntry[];
  preferences: WhatIKnowEntry[];
  other: WhatIKnowEntry[];
  lessons: WhatIKnowLesson[];
}

const BELIEF_KINDS = new Set(["fact", "business_fact", "person_profile"]);
const PREFERENCE_KINDS = new Set(["instruction"]);

/** Pure grouping: current memories + current episodes -> the model view. */
export function groupWhatIKnow(
  memories: WhatIKnowEntry[],
  episodes: EpisodeRow[],
): WhatIKnowModel {
  const beliefs: WhatIKnowEntry[] = [];
  const preferences: WhatIKnowEntry[] = [];
  const other: WhatIKnowEntry[] = [];
  for (const m of memories) {
    if (BELIEF_KINDS.has(m.kind)) beliefs.push(m);
    else if (PREFERENCE_KINDS.has(m.kind)) preferences.push(m);
    else other.push(m);
  }
  return {
    beliefs,
    preferences,
    other,
    lessons: episodes.map((e) => ({ ...e, evidence: e.situation })),
  };
}

/** Loads the model for one company. Never throws on a missing table — [] pre-00092 / pre-00014. */
export async function loadWhatIKnowModel(
  client: SupabaseClient,
  companyId: string,
  options: { limit?: number } = {},
): Promise<WhatIKnowModel> {
  const limit = options.limit ?? 500;
  const { data, error } = await client
    .from("bot_memories")
    .select("id, kind, content, created_at, valid_to, superseded_by")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .is("valid_to", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  let memories: WhatIKnowEntry[] = [];
  if (!error) {
    memories = ((data ?? []) as WhatIKnowEntry[]).map((row) => ({
      ...row,
      valid_to: row.valid_to ?? null,
      superseded_by: row.superseded_by ?? null,
    }));
  } else if (!(/bot_memories/.test(error.message) && /does not exist|could not find/i.test(error.message))) {
    throw new Error(error.message);
  }
  const episodes = await listEpisodes(client, companyId, { limit });
  return groupWhatIKnow(memories, episodes);
}

/**
 * The model as plain text, one line per item with its evidence —
 * the /model reply and the app page's text fallback. Lessons are
 * numbered in display order so a correct-by-reply message can
 * name one ("correct lesson 2: ...").
 */
export function formatWhatIKnowText(model: WhatIKnowModel): string {
  const lines: string[] = ["What I know about you:"];
  if (model.beliefs.length > 0) {
    lines.push("Beliefs:");
    for (const b of model.beliefs) lines.push(`- [${b.kind}] ${b.content}`);
  }
  if (model.preferences.length > 0) {
    lines.push("Preferences:");
    for (const p of model.preferences) lines.push(`- ${p.content}`);
  }
  if (model.other.length > 0) {
    lines.push("Other notes:");
    for (const o of model.other) lines.push(`- [${o.kind}] ${o.content}`);
  }
  if (model.lessons.length > 0) {
    lines.push("Lessons I've learned:");
    model.lessons.forEach((l, i) => {
      lines.push(`${i + 1}. ${l.lesson ?? l.summary}${l.evidence ? ` (from: ${l.evidence})` : ""}`);
    });
  }
  if (model.beliefs.length === 0 && model.preferences.length === 0 && model.other.length === 0 && model.lessons.length === 0) {
    lines.push("Nothing stored yet — tell me something worth keeping and it will show up here.");
  }
  lines.push("If anything above is wrong, tell me which one and what's right — I'll stage the correction for your yes, I won't change it silently.");
  return lines.join("\n");
}
