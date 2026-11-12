// Lane 2 (Abel Intelligence Upgrade, Phase B) — memory lifecycle:
// bi-temporal supersession and dedup, per design §3.4.
//
// The rules:
// - A new fact never edits or deletes an old row. It CLOSES it:
//   valid_to is set and superseded_by points at the new row, so
//   "what did he used to say?" stays answerable forever.
// - Structured profiles carry their own identity: a BUSINESS line
//   is the same subject as another BUSINESS line with the same
//   subject. A PERSON line needs more than a name (pitfall hunt
//   CD-4): two different people can share a name, so a person
//   profile auto-supersedes only when name AND role both match;
//   a same-name profile that can't be confirmed is staged as an
//   update proposal for the owner's yes/no instead of being
//   silently closed (people.ts' parsers provide name + role).
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

/**
 * CD-4: are these two PERSON profile lines the same person? The
 * parsers extract exactly two identity attributes - name and role -
 * so identity is confirmed only when BOTH match (case-insensitive)
 * and both roles are present. A name alone confirms nothing: a
 * second person with the same first name (a broker, a cousin) must never
 * silently close the first one's profile.
 */
export function personIdentityConfirmed(newContent: string, existingContent: string): boolean {
  const a = parsePersonProfile(newContent);
  const b = parsePersonProfile(existingContent);
  if (!a || !b) return false;
  if (a.name.trim().toLowerCase() !== b.name.trim().toLowerCase()) return false;
  if (!a.role || !b.role) return false;
  return a.role.trim().toLowerCase() === b.role.trim().toLowerCase();
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
 *
 * CD-4 exception: a PERSON candidate whose identity the new row
 * cannot confirm (same name, but the role is missing on either
 * side or differs) is NOT closed. When the caller provides
 * onAmbiguousPersonMatch it is invoked once per such row so the
 * question can be staged for the owner (the store stages an update
 * proposal); without a callback the row is simply left current.
 * An explicitly named row (supersedesId) always closes - the
 * owner (or an approved proposal) named it, no guessing involved.
 *
 * Graceful absence: before migration 00029 the lifecycle columns
 * don't exist - supersession silently no-ops and the insert that
 * already happened stands, exactly the pre-Lane-2 behavior.
 */
export async function applySupersession(
  client: SupabaseClient,
  companyId: string,
  newRow: { id: string; kind: string; content: string },
  options: {
    supersedesId?: string;
    now?: Date;
    onAmbiguousPersonMatch?: (oldRow: CurrentMemoryRow) => Promise<void>;
  } = {},
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

  const toClose: CurrentMemoryRow[] = [];
  const ambiguous: CurrentMemoryRow[] = [];
  for (const row of candidates) {
    if (row.id === options.supersedesId) {
      toClose.push(row);
    } else if (
      newRow.kind === "person_profile" &&
      !personIdentityConfirmed(newRow.content, row.content)
    ) {
      ambiguous.push(row);
    } else {
      toClose.push(row);
    }
  }

  let closed: CurrentMemoryRow[] = [];
  if (toClose.length > 0) {
    const ids = toClose.map((row) => row.id);
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
    closed = toClose;
  }

  // Staging the question is best-effort: the new profile is already
  // saved, and a failed proposal must not fail the save - but it is
  // never silent either.
  for (const row of ambiguous) {
    if (!options.onAmbiguousPersonMatch) break;
    try {
      await options.onAmbiguousPersonMatch(row);
    } catch (err) {
      console.error("[memory-lifecycle] failed to stage same-name profile proposal", err);
    }
  }
  return closed;
}

export interface ChainMemoryRow extends CurrentMemoryRow {
  superseded_by: string | null;
}

/**
 * Frontier 2-B — the supersession-chain reader for bot_memories,
 * mirroring episodeSupersessionChain (episodes.ts): given any row
 * in a chain, return the full chain oldest first — "what did I
 * used to believe" stays answerable, with superseded_by naming
 * who superseded whom at each step. [] when the row doesn't exist
 * (or pre-00029, when the lifecycle columns don't exist).
 */
export async function memorySupersessionChain(
  client: SupabaseClient,
  companyId: string,
  memoryId: string,
): Promise<ChainMemoryRow[]> {
  const load = async (id: string): Promise<ChainMemoryRow | null> => {
    const { data, error } = await client
      .from("bot_memories")
      .select("id, kind, content, created_at, superseded_by")
      .eq("company_id", companyId)
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) return null;
    const row = (data as ChainMemoryRow | null) ?? null;
    return row ? { ...row, superseded_by: row.superseded_by ?? null } : null;
  };
  const start = await load(memoryId);
  if (!start) return [];
  // Forward to the newest row in the chain.
  let newest = start;
  const forwardSeen = new Set<string>([start.id]);
  while (newest.superseded_by && !forwardSeen.has(newest.superseded_by)) {
    const next = await load(newest.superseded_by);
    if (!next) break;
    forwardSeen.add(next.id);
    newest = next;
  }
  // Backward to the oldest: predecessors are rows whose
  // superseded_by points at the current oldest. (The backward
  // walk has its own seen-set: the start row is legitimately met
  // again here when the chain was entered from its old end.)
  const chain: ChainMemoryRow[] = [newest];
  const seen = new Set<string>([newest.id]);
  let oldest = newest;
  while (true) {
    const { data, error } = await client
      .from("bot_memories")
      .select("id, kind, content, created_at, superseded_by")
      .eq("company_id", companyId)
      .eq("superseded_by", oldest.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (error || !data) break;
    const prev = data as ChainMemoryRow;
    if (seen.has(prev.id)) break;
    seen.add(prev.id);
    chain.unshift({ ...prev, superseded_by: prev.superseded_by ?? null });
    oldest = prev;
  }
  return chain;
}
