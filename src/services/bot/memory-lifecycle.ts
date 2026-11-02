// Lane 2 (Abel Intelligence Upgrade, Phase B) — memory lifecycle:
// bi-temporal supersession and dedup, per design §3.4.
//
// The rules:
// - A new fact never edits or deletes an old row. It CLOSES it:
//   valid_to is set and superseded_by points at the new row, so
//   "what did he used to say?" stays answerable forever.
// - Structured profiles carry their own identity: a PERSON line is
//   the same subject as another PERSON line with the same name; a
//   BUSINESS line likewise by subject. A new profile for a subject
//   supersedes the subject's previous current line (people.ts'
//   parsers - until now dead code - provide the keys).
// - Plain facts have no reliable subject key, so they supersede
//   only when a caller names the row (a proposal that was staged as
//   an explicit update, or the owner's own edit) - plus the
//   similarity machinery below, which the night shift uses to STAGE
//   update proposals. Similarity never closes a row by itself.

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseBusinessFact, parsePersonProfile } from "./people";
import { isMissingColumnError } from "./tool-helpers";

/** Stable subject identity for structured memories; null for plain facts/notes/instructions. */
export function memorySubjectKey(kind: string, content: string): string | null {
  if (kind === "person_profile") {
    const parsed = parsePersonProfile(content);
    return parsed ? `person:${parsed.name.trim().toLowerCase()}` : null;
  }
  if (kind === "business_fact") {
    const parsed = parseBusinessFact(content);
    return parsed ? `business:${parsed.subject.trim().toLowerCase()}` : null;
  }
  return null;
}

const SIM_STOP_WORDS = new Set([
  "what", "when", "where", "which", "does", "have", "this", "that", "with",
  "from", "about", "much", "many", "week", "today", "there", "their", "them",
  "the", "and", "for", "his", "her", "him",
]);

export function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9áéíóúñ ]/gi, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !SIM_STOP_WORDS.has(w)),
  );
}

/** Jaccard similarity over content tokens: 1 = same words, 0 = disjoint. The dedup/update bands live in consolidation.ts. */
export function tokenSimilarity(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

export interface CurrentMemoryRow {
  id: string;
  kind: string;
  content: string;
  created_at: string;
}

/**
 * Closes every CURRENT row that the new row supersedes: same
 * subject key (profiles/business facts), plus any row the caller
 * named explicitly. Returns the closed rows (for reporting/tests).
 * Graceful absence: before migration 00029 the lifecycle columns
 * don't exist - supersession silently no-ops and the insert that
 * already happened stands, exactly the pre-Lane-2 behavior.
 */
export async function applySupersession(
  client: SupabaseClient,
  companyId: string,
  newRow: { id: string; kind: string; content: string },
  options: { supersedesId?: string; now?: Date } = {},
): Promise<CurrentMemoryRow[]> {
  const nowIso = (options.now ?? new Date()).toISOString();
  const key = memorySubjectKey(newRow.kind, newRow.content);

  let candidates: CurrentMemoryRow[] = [];
  if (key) {
    const { data, error } = await client
      .from("bot_memories")
      .select("id, kind, content, created_at")
      .eq("company_id", companyId)
      .eq("kind", newRow.kind)
      .is("deleted_at", null)
      .is("valid_to", null);
    if (error) {
      if (isMissingColumnError(error)) return [];
      throw new Error(error.message);
    }
    candidates = ((data ?? []) as CurrentMemoryRow[]).filter(
      (row) => row.id !== newRow.id && memorySubjectKey(row.kind, row.content) === key,
    );
  }
  if (options.supersedesId && options.supersedesId !== newRow.id) {
    const already = candidates.some((row) => row.id === options.supersedesId);
    if (!already) {
      const { data } = await client
        .from("bot_memories")
        .select("id, kind, content, created_at")
        .eq("company_id", companyId)
        .eq("id", options.supersedesId)
        .is("deleted_at", null)
        .is("valid_to", null)
        .maybeSingle();
      if (data) candidates.push(data as CurrentMemoryRow);
    }
  }
  if (candidates.length === 0) return [];

  const ids = candidates.map((row) => row.id);
  const { error: updateError } = await client
    .from("bot_memories")
    .update({ valid_to: nowIso, superseded_by: newRow.id })
    .in("id", ids)
    .eq("company_id", companyId)
    .is("valid_to", null);
  if (updateError) {
    if (isMissingColumnError(updateError)) return [];
    throw new Error(updateError.message);
  }
  return candidates;
}
