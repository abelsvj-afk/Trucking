// Frontier 2 (Remember better) — the agent_episodes store: Abel's
// own autobiography (what he said, recommended, did, got wrong,
// and learned). Same conventions as bot_memories: company_id +
// tenant-isolation RLS, soft delete, bi-temporal supersession (a
// correction CLOSES the old row, never edits or deletes it), and
// hybrid FTS + pgvector search (abel_search_episodes, migration
// 00092) with the half-life re-rank from half-life.ts.
//
// Every query here filters company_id — the tenant-suite surface
// for this table (see episodes.test.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingColumnError } from "./tool-helpers";
import { tokenSimilarity } from "./memory-lifecycle";
import { staleFiguresInReply } from "@/services/ai/agent-loop";
import { toVectorLiteral, tryEmbed, type EmbeddingProvider } from "./embeddings";
import { rerankWithHalfLife } from "./half-life";

export type EpisodeKind = "said" | "recommended" | "acted" | "erred" | "learned";
export type EpisodeValence = "helped" | "hurt" | "neutral";
export type EpisodeProvenance = "owner_stated" | "document" | "owner_confirmed_inference" | "model_inferred_unconfirmed";

export interface EpisodeRow {
  id: string;
  kind: EpisodeKind;
  summary: string;
  situation: string | null;
  lesson: string | null;
  valence: EpisodeValence | null;
  confidence: number | null;
  provenance: string;
  created_at: string;
  valid_to: string | null;
  superseded_by: string | null;
}

export interface EpisodeInput {
  kind: EpisodeKind;
  summary: string;
  situation?: string | null;
  lesson?: string | null;
  valence?: EpisodeValence | null;
  confidence?: number | null;
  provenance?: EpisodeProvenance;
  supersedesId?: string;
}

const EPISODE_COLUMNS = "id, kind, summary, situation, lesson, valence, confidence, provenance, created_at, valid_to, superseded_by";

async function safeRpc(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<{ data: unknown; error: { message: string } | null }> {
  const rpcFn = (client as { rpc?: unknown }).rpc;
  if (typeof rpcFn !== "function") {
    return { data: null, error: { message: `rpc ${fn} unavailable on this client` } };
  }
  try {
    const result = await (rpcFn as (name: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>).call(client, fn, args);
    return { data: result.data ?? null, error: result.error ?? null };
  } catch (err) {
    return { data: null, error: { message: err instanceof Error ? err.message : String(err) } };
  }
}

/** Insert one episode. Null when the table isn't there yet (pre-00092); throws on any other failure. */
export async function saveEpisode(
  client: SupabaseClient,
  companyId: string,
  input: EpisodeInput,
  options: { embedder?: EmbeddingProvider | null } = {},
): Promise<string | null> {
  const { data, error } = await client
    .from("agent_episodes")
    .insert({
      company_id: companyId,
      kind: input.kind,
      summary: input.summary,
      situation: input.situation ?? null,
      lesson: input.lesson ?? null,
      valence: input.valence ?? null,
      confidence: input.confidence ?? null,
      provenance: input.provenance ?? "model_inferred_unconfirmed",
      supersedes_id: input.supersedesId ?? null,
    })
    .select("id")
    .single();
  if (error) {
    if (/agent_episodes/.test(error.message) && /does not exist|could not find/i.test(error.message)) return null;
    throw new Error(error.message);
  }
  const newId = (data as { id?: string } | null)?.id ?? null;
  if (!newId) return null;
  // Best-effort embedding at write time (the night shift backfills
  // anything missed); a missing embedding column is pre-00092.
  const provider = options.embedder === undefined ? null : options.embedder;
  const vector = provider ? await tryEmbed(provider, `${input.summary} ${input.lesson ?? ""}`) : null;
  if (vector && provider) {
    const { error: embedError } = await client
      .from("agent_episodes")
      .update({ embedding: toVectorLiteral(vector), embedding_model: provider.model })
      .eq("id", newId)
      .eq("company_id", companyId);
    if (embedError && !isMissingColumnError(embedError)) {
      console.error("[episodes] embedding write failed", embedError.message);
    }
  }
  if (input.supersedesId) {
    await applyEpisodeSupersession(client, companyId, { id: newId, kind: input.kind, summary: input.summary }, { supersedesId: input.supersedesId });
  }
  return newId;
}

/** Current episodes (newest first), plus superseded history when asked. Never throws on a missing table — [] pre-00092. */
export async function listEpisodes(
  client: SupabaseClient,
  companyId: string,
  options: { includeHistory?: boolean; limit?: number; kind?: EpisodeKind } = {},
): Promise<EpisodeRow[]> {
  let q = client
    .from("agent_episodes")
    .select(EPISODE_COLUMNS)
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(options.limit ?? 500);
  if (!options.includeHistory) q = q.is("valid_to", null);
  if (options.kind) q = q.eq("kind", options.kind);
  const { data, error } = await q;
  if (error) {
    if (/agent_episodes/.test(error.message) && /does not exist|could not find/i.test(error.message)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as EpisodeRow[];
}

/**
 * Generalizes the applySupersession pattern to agent_episodes.
 * Episodes carry no subject key (a lesson has no parseable
 * person/business identity), so ONLY an explicitly named row
 * closes — an explicit supersedesId ALWAYS closes. Close, never
 * delete: valid_to is set and superseded_by points at the new row.
 * Graceful absence pre-00092: no-op, [].
 */
export async function applyEpisodeSupersession(
  client: SupabaseClient,
  companyId: string,
  newRow: { id: string; kind: string; summary: string },
  options: { supersedesId?: string; now?: Date } = {},
): Promise<{ id: string; kind: string; summary: string }[]> {
  if (!options.supersedesId || options.supersedesId === newRow.id) return [];
  const nowIso = (options.now ?? new Date()).toISOString();
  const { data, error } = await client
    .from("agent_episodes")
    .select("id, kind, summary")
    .eq("company_id", companyId)
    .eq("id", options.supersedesId)
    .is("deleted_at", null)
    .is("valid_to", null)
    .maybeSingle();
  if (error) {
    if (isMissingColumnError(error)) return [];
    throw new Error(error.message);
  }
  if (!data) return [];
  const { error: updateError } = await client
    .from("agent_episodes")
    .update({ valid_to: nowIso, superseded_by: newRow.id })
    .eq("id", options.supersedesId)
    .eq("company_id", companyId)
    .is("valid_to", null);
  if (updateError) {
    if (isMissingColumnError(updateError)) return [];
    throw new Error(updateError.message);
  }
  return [data as { id: string; kind: string; summary: string }];
}

/**
 * The full supersession chain for one episode, oldest first:
 * "what did I used to believe" stays answerable. Each entry names
 * who superseded it (superseded_by). Works from any row in the
 * chain — it walks forward to the newest, then backward to the
 * oldest. [] when the row doesn't exist (or pre-00092).
 */
export async function episodeSupersessionChain(
  client: SupabaseClient,
  companyId: string,
  episodeId: string,
): Promise<EpisodeRow[]> {
  const load = async (id: string): Promise<EpisodeRow | null> => {
    const { data, error } = await client
      .from("agent_episodes")
      .select(EPISODE_COLUMNS)
      .eq("company_id", companyId)
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) return null;
    return (data as EpisodeRow | null) ?? null;
  };
  const start = await load(episodeId);
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
  const chain: EpisodeRow[] = [newest];
  const seen = new Set<string>([newest.id]);
  let oldest = newest;
  while (true) {
    const { data, error } = await client
      .from("agent_episodes")
      .select(EPISODE_COLUMNS)
      .eq("company_id", companyId)
      .eq("superseded_by", oldest.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (error || !data) break;
    const prev = data as EpisodeRow;
    if (seen.has(prev.id)) break;
    seen.add(prev.id);
    chain.unshift(prev);
    oldest = prev;
  }
  return chain;
}

/**
 * Hybrid search over current episodes (RPC when 00092 is live,
 * keyword fallback before it), re-ranked by the episode half-life
 * (7d) — a 30-day-old episode ranks below a fresh fact of equal
 * similarity. Never throws: [] on a missing table.
 */
export async function searchEpisodes(
  client: SupabaseClient,
  companyId: string,
  query: string,
  options: { embedder?: EmbeddingProvider | null; limit?: number; now?: Date } = {},
): Promise<(EpisodeRow & { score: number; decayedScore: number })[]> {
  const limit = options.limit ?? 12;
  const nowMs = (options.now ?? new Date()).getTime();
  const embedding = await tryEmbed(options.embedder ?? null, query);
  const rpc = await safeRpc(client, "abel_search_episodes", {
    p_company_id: companyId,
    p_query: query,
    p_embedding: embedding ? toVectorLiteral(embedding) : null,
    p_limit: Math.max(limit * 2, limit),
    p_include_history: false,
  });
  let rows: { row: EpisodeRow; score: number }[] = [];
  if (!rpc.error && Array.isArray(rpc.data)) {
    rows = (rpc.data as (EpisodeRow & { rrf_score?: number })[]).map((row, index) => ({
      row,
      score: typeof row.rrf_score === "number" ? row.rrf_score : 1 / (index + 1),
    }));
  } else {
    const { data, error } = await client
      .from("agent_episodes")
      .select(EPISODE_COLUMNS)
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .is("valid_to", null)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      if (/agent_episodes/.test(error.message) && /does not exist|could not find/i.test(error.message)) return [];
      throw new Error(error.message);
    }
    const queryTokens = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
    const scored = ((data ?? []) as EpisodeRow[])
      .map((row, index) => {
        const text = `${row.summary} ${row.lesson ?? ""}`.toLowerCase();
        const overlap = queryTokens.filter((t) => text.includes(t)).length;
        return { row, index, overlap };
      })
      .filter((s) => s.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || a.index - b.index);
    rows = scored.map((s, i) => ({ row: s.row, score: 1 / (i + 1) }));
  }
  const ranked = rerankWithHalfLife(
    rows.map((r) => ({ id: r.row.id, kind: "episode", created_at: r.row.created_at, score: r.score })),
    nowMs,
  );
  const byId = new Map(rows.map((r) => [r.row.id, r.row]));
  return ranked.slice(0, limit).map((r) => ({ ...byId.get(r.id)!, score: r.score, decayedScore: r.decayedScore }));
}

/**
 * Owner correction of one episode (F2-D): saves the corrected
 * lesson as a NEW row at max confidence with provenance
 * owner_stated, closing the old row. Resolves the new row's id.
 */
export async function correctEpisode(
  client: SupabaseClient,
  companyId: string,
  episodeId: string,
  newLesson: string,
): Promise<string> {
  const { data: existing, error: loadError } = await client
    .from("agent_episodes")
    .select("id, kind, summary, situation")
    .eq("id", episodeId)
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .is("valid_to", null)
    .maybeSingle();
  if (loadError) throw new Error(loadError.message);
  if (!existing) throw new Error("That lesson doesn't exist (or was already replaced).");
  const old = existing as { kind: EpisodeKind; summary: string; situation: string | null };
  const newId = await saveEpisode(client, companyId, {
    kind: old.kind,
    summary: old.summary,
    situation: old.situation,
    lesson: newLesson,
    valence: null,
    confidence: 1,
    provenance: "owner_stated",
    supersedesId: episodeId,
  });
  if (!newId) throw new Error("The corrected lesson couldn't be saved.");
  return newId;
}

/** Hot-path projection (acted, no LLM): an approved + executed proposal becomes an episode. Best-effort — never throws. */
export async function recordActedEpisode(
  client: SupabaseClient,
  companyId: string,
  entry: { tool: string; summary: string; valence?: EpisodeValence },
): Promise<string | null> {
  try {
    return await saveEpisode(client, companyId, {
      kind: "acted",
      summary: `Did ${entry.tool}: ${entry.summary}`,
      lesson: null,
      valence: entry.valence ?? "helped",
      confidence: 0.9,
      provenance: "model_inferred_unconfirmed",
    });
  } catch (err) {
    console.error("[episodes] acted episode write failed (best-effort, turn unaffected)", err);
    return null;
  }
}

/** Correction path (erred, free): the owner corrected Abel — capture old → new and the lesson it taught. Best-effort — never throws. */
export async function recordErredEpisode(
  client: SupabaseClient,
  companyId: string,
  entry: { oldText: string; newText: string; context?: string; lesson?: string },
): Promise<string | null> {
  try {
    return await saveEpisode(client, companyId, {
      kind: "erred",
      summary: `Corrected${entry.context ? ` (${entry.context})` : ""}: "${entry.oldText}" → "${entry.newText}"`,
      lesson: entry.lesson ?? `I had "${entry.oldText}" — he corrected it to "${entry.newText}". Check the record before stating it again.`,
      valence: "hurt",
      confidence: 0.9,
      provenance: "owner_stated",
    });
  } catch (err) {
    console.error("[episodes] erred episode write failed (best-effort, turn unaffected)", err);
    return null;
  }
}

/** Same duplicate band as consolidation facts (0.9): a lesson this similar to one already kept is already-known. */
export const LESSON_DUPLICATE_SIMILARITY = 0.9;

/**
 * Consolidation-time synthesis guard (Frontier 1's verification,
 * applied to synthesis): each candidate lesson is checked against
 * fresh current facts (groundingTexts) with staleFiguresInReply —
 * a lesson quoting a superseded figure is DROPPED, never staged —
 * and against already-kept lessons (similarity ≥ 0.9 drops as a
 * duplicate). Pure: the caller stages what comes back.
 */
export function synthesizeLearnedLessons(input: {
  lessons: string[];
  existingLessons: string[];
  groundingTexts: string[];
}): string[] {
  const kept: string[] = [];
  for (const lesson of input.lessons) {
    const text = lesson.trim();
    if (!text) continue;
    if (staleFiguresInReply(text, input.groundingTexts).length > 0) continue;
    const dup = [...input.existingLessons, ...kept].some(
      (other) => tokenSimilarity(text, other) >= LESSON_DUPLICATE_SIMILARITY,
    );
    if (dup) continue;
    kept.push(text);
  }
  return kept;
}
