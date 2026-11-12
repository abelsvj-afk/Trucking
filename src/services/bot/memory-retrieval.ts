// Lane 2 (Abel Intelligence Upgrade, Phase A) — hybrid retrieval
// over the WHOLE memory store. This file replaces the v1 pattern
// (load newest 100 rows, keyword-pick 8) everywhere context is
// assembled: the 100-row cliff is gone because retrieval now
// QUERIES the store instead of loading a slice of it.
//
// Primary path: the abel_search_* SQL functions from migration
// 00029 - Postgres FTS + pgvector fused with reciprocal rank
// fusion (RRF) inside the database, over every current fact.
// Fallback path (00029 not applied yet, or the RPC failing):
// keyword scoring over the NEWEST 1,000 current rows + recency.
// That window is itself a cliff - facts older than the newest
// 1,000 are unreachable in fallback mode, including through
// search_memory (its fallback memory arm scans the same window).
// Pitfall hunt CD-3: the fallback must therefore DISCLOSE itself -
// the report line names the mode, the scanned window, and what
// stayed unreachable. It never borrows the hybrid line's promise.
//
// Self-report rule (design §3.5): every retrieval that truncates
// says so - "showing X of Y" - and the caller puts that line in the
// context the model sees.

import type { SupabaseClient } from "@supabase/supabase-js";
import { tokenSet } from "./memory-lifecycle";
import { isMissingColumnError } from "./tool-helpers";
import { toVectorLiteral, tryEmbed, type EmbeddingProvider } from "./embeddings";
import { rerankWithHalfLife } from "./half-life";

export const FACT_LIMIT = 12;
export const FACT_TOKEN_BUDGET = 600;
/** Fallback-mode scan window: the newest this-many current facts are keyword-scanned; anything older is unreachable until 00029 lands (CD-3). */
export const FALLBACK_SCAN_LIMIT = 1000;

/** Rough token estimate (chars / 4) - budgets only, never billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Reciprocal rank fusion over ranked id lists (k = 60, the Supabase hybrid-search convention). Pure - unit-tested directly. */
export function fuseRrf(lists: string[][], k = 60): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

export interface RetrievedFact {
  id: string;
  kind: string;
  content: string;
  created_at: string;
}

export interface FactRetrieval {
  facts: RetrievedFact[];
  /** Total CURRENT facts in the store (the Y in "X of Y"). */
  totalFacts: number;
  /** True when the budget or limit cut the list - the caller must surface the report line. */
  truncated: boolean;
  /** Which engine produced this retrieval - the report line's honesty depends on it (CD-3). */
  mode: "hybrid" | "fallback";
  /** How many current facts the engine actually scanned (fallback: at most FALLBACK_SCAN_LIMIT; hybrid: the whole store). */
  scannedFacts: number;
  reportLine: string;
}

interface MemoryQueryRow {
  id: string;
  kind: string;
  content: string;
  created_at: string;
  /** RRF score from the hybrid RPC (00029) — absent on the fallback path. */
  rrf_score?: number;
}

/**
 * RPC with total failure tolerance: a client without the function
 * (pre-00029 database, or a test fake) yields an error result and
 * the caller falls back - retrieval must never take a turn down.
 */
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

async function countCurrentFacts(client: SupabaseClient, companyId: string): Promise<number> {
  const withValidity = await client
    .from("bot_memories")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .is("valid_to", null);
  if (!withValidity.error) return withValidity.count ?? 0;
  if (!isMissingColumnError(withValidity.error)) throw new Error(withValidity.error.message);
  const plain = await client
    .from("bot_memories")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .is("deleted_at", null);
  if (plain.error) throw new Error(plain.error.message);
  return plain.count ?? 0;
}

export interface FallbackScan {
  rows: MemoryQueryRow[];
  /** Rows actually scanned (the window size this call saw) - CD-3: the self-report must be able to name it. */
  scanned: number;
}

/** Keyword-scored scan used when the SQL hybrid functions aren't live yet. Scores content overlap, ties break toward importance-agnostic recency. Only the newest FALLBACK_SCAN_LIMIT current rows are scanned - callers must disclose that window (CD-3). */
export async function fallbackFactScan(
  client: SupabaseClient,
  companyId: string,
  query: string,
  limit: number,
): Promise<FallbackScan> {
  const run = (withValidity: boolean) => {
    let q = client
      .from("bot_memories")
      .select("id, kind, content, created_at")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(FALLBACK_SCAN_LIMIT);
    if (withValidity) q = q.is("valid_to", null);
    return q;
  };
  let result = await run(true);
  if (result.error && isMissingColumnError(result.error)) result = await run(false);
  if (result.error) throw new Error(result.error.message);
  const rows = (result.data ?? []) as MemoryQueryRow[];
  const queryTokens = tokenSet(query);
  const scored = rows.map((row, index) => {
    const words = tokenSet(row.content);
    let overlap = 0;
    for (const token of words) if (queryTokens.has(token)) overlap += 1;
    return { row, index, overlap };
  });
  const picked = scored
    .sort((a, b) => b.overlap - a.overlap || a.index - b.index)
    .slice(0, limit)
    .map((s) => s.row);
  return { rows: picked, scanned: rows.length };
}

/**
 * The current-facts block for one turn: hybrid retrieval over ALL
 * current facts, cut to the design budget (≤12 facts / ~600 tokens)
 * with a mandatory self-report line.
 */
export async function retrieveCurrentFacts(
  client: SupabaseClient,
  companyId: string,
  query: string,
  options: { embedder?: EmbeddingProvider | null; limit?: number; tokenBudget?: number } = {},
): Promise<FactRetrieval> {
  const limit = options.limit ?? FACT_LIMIT;
  const tokenBudget = options.tokenBudget ?? FACT_TOKEN_BUDGET;
  const totalFacts = await countCurrentFacts(client, companyId);

  let candidates: MemoryQueryRow[] | null = null;
  let mode: FactRetrieval["mode"] = "hybrid";
  let scannedFacts = totalFacts;
  const embedding = await tryEmbed(options.embedder ?? null, query);
  const rpc = await safeRpc(client, "abel_search_memories", {
    p_company_id: companyId,
    p_query: query,
    p_embedding: embedding ? toVectorLiteral(embedding) : null,
    p_limit: Math.max(limit * 2, limit),
    p_include_history: false,
  });
  if (!rpc.error && Array.isArray(rpc.data)) {
    candidates = (rpc.data as MemoryQueryRow[]).map((row) => ({
      id: row.id,
      kind: row.kind,
      content: row.content,
      created_at: row.created_at,
      rrf_score: typeof row.rrf_score === "number" ? row.rrf_score : undefined,
    }));
  } else {
    mode = "fallback";
    const scan = await fallbackFactScan(client, companyId, query, Math.max(limit * 2, limit));
    candidates = scan.rows;
    scannedFacts = scan.scanned;
  }

  // Frontier 2: per-kind half-lives compose with the RRF scores —
  // a 30-day-old episode ranks below a fresh fact of equal
  // similarity. Decay ranks, never deletes; the budget cut below
  // runs on the decayed order.
  const ranked = rerankWithHalfLife(
    candidates.map((row, index) => ({
      id: row.id,
      kind: row.kind,
      content: row.content,
      created_at: row.created_at,
      score: row.rrf_score ?? 1 / (index + 1),
    })),
  );
  candidates = ranked.map(({ id, kind, content, created_at }) => ({ id, kind, content, created_at }));

  const facts: RetrievedFact[] = [];
  let tokens = 0;
  for (const row of candidates) {
    if (facts.length >= limit) break;
    const cost = estimateTokens(row.content);
    if (facts.length > 0 && tokens + cost > tokenBudget) break;
    facts.push(row);
    tokens += cost;
  }
  const truncated = totalFacts > facts.length;
  // CD-3: the line must tell the truth about the MODE. In fallback
  // mode the cut can be the scan window (not the budget), and facts
  // beyond the window are unreachable - search_memory's fallback
  // memory arm scans the same window, so the hybrid line's "the
  // rest stay searchable" promise would be false here.
  let reportLine: string;
  if (mode === "hybrid") {
    reportLine = truncated
      ? `Memory: showing the ${facts.length} most relevant of ${totalFacts} current facts (budget-limited; the rest stay searchable via search_memory).`
      : `Memory: all ${totalFacts} current facts fit this turn's budget - nothing held back.`;
  } else if (!truncated) {
    reportLine =
      `Memory (compatibility mode - hybrid search from migration 00029 isn't live yet, so this turn keyword-matched): ` +
      `all ${totalFacts} current facts fit this turn's budget - nothing held back.`;
  } else if (totalFacts > scannedFacts) {
    reportLine =
      `Memory (compatibility mode - migration 00029 isn't applied yet): showing the ${facts.length} most relevant of the newest ` +
      `${scannedFacts} facts scanned, out of ${totalFacts} current facts. The ${totalFacts - scannedFacts} older facts beyond that ` +
      `scan window were not reachable this turn - search_memory scans the same window in this mode, so they stay unreachable until 00029 is applied.`;
  } else {
    reportLine =
      `Memory (compatibility mode - migration 00029 isn't applied yet): showing the ${facts.length} most relevant of ${totalFacts} ` +
      `current facts (budget-limited; keyword-matched over all ${scannedFacts} scanned facts - the rest stay searchable via search_memory, which scans the same window).`;
  }
  return { facts, totalFacts, truncated, mode, scannedFacts, reportLine };
}

/** Standing instructions are procedural memory: ALL of them, every turn, never retrieved-by-relevance (design §3.1). No 100-row window anywhere near them. */
export async function loadAllInstructions(
  client: SupabaseClient,
  companyId: string,
): Promise<RetrievedFact[]> {
  const run = (withValidity: boolean) => {
    let q = client
      .from("bot_memories")
      .select("id, kind, content, created_at")
      .eq("company_id", companyId)
      .eq("kind", "instruction")
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .limit(FALLBACK_SCAN_LIMIT);
    if (withValidity) q = q.is("valid_to", null);
    return q;
  };
  let result = await run(true);
  if (result.error && isMissingColumnError(result.error)) result = await run(false);
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []) as RetrievedFact[];
}

export interface MemorySearchHit {
  source: "memory" | "message" | "document";
  id: string;
  snippet: string;
  created_at: string;
}

/**
 * The search_memory tool's engine: hybrid search across facts,
 * conversation turns, and documents in one call (design §3.5 - the
 * on-demand path to anything the context blocks didn't include).
 * Each store degrades independently pre-00029 (ilike / keyword),
 * so the tool works before the migration lands and gets sharper
 * after it.
 */
export async function searchMemoryEverywhere(
  client: SupabaseClient,
  companyId: string,
  query: string,
  options: { embedder?: EmbeddingProvider | null; perStore?: number } = {},
): Promise<MemorySearchHit[]> {
  const perStore = options.perStore ?? 8;
  const embedding = await tryEmbed(options.embedder ?? null, query);
  const embeddingArg = embedding ? toVectorLiteral(embedding) : null;
  const hits: MemorySearchHit[] = [];

  const memoryRpc = await safeRpc(client, "abel_search_memories", {
    p_company_id: companyId,
    p_query: query,
    p_embedding: embeddingArg,
    p_limit: perStore,
    p_include_history: true,
  });
  if (!memoryRpc.error && Array.isArray(memoryRpc.data)) {
    for (const row of memoryRpc.data as MemoryQueryRow[]) {
      hits.push({ source: "memory", id: row.id, snippet: row.content, created_at: row.created_at });
    }
  } else {
    // CD-3: this fallback arm scans the same newest-1,000 window as
    // context retrieval - the CONTEXT REPORT line discloses that;
    // this tool never claims a wider reach than the scan it ran.
    const scan = await fallbackFactScan(client, companyId, query, perStore);
    for (const row of scan.rows) {
      hits.push({ source: "memory", id: row.id, snippet: row.content, created_at: row.created_at });
    }
  }

  const messageRpc = await safeRpc(client, "abel_search_messages", {
    p_company_id: companyId,
    p_query: query,
    p_embedding: embeddingArg,
    p_limit: perStore,
  });
  if (!messageRpc.error && Array.isArray(messageRpc.data)) {
    for (const row of messageRpc.data as { id: string; text: string; created_at: string }[]) {
      hits.push({ source: "message", id: row.id, snippet: row.text, created_at: row.created_at });
    }
  } else {
    const { data } = await client
      .from("telegram_messages")
      .select("id, text, created_at")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .ilike("text", `%${query}%`)
      .order("created_at", { ascending: false })
      .limit(perStore);
    for (const row of (data ?? []) as { id: string; text: string; created_at: string }[]) {
      hits.push({ source: "message", id: row.id, snippet: row.text, created_at: row.created_at });
    }
  }

  const documentRpc = await safeRpc(client, "abel_search_documents", {
    p_company_id: companyId,
    p_query: query,
    p_embedding: embeddingArg,
    p_limit: perStore,
  });
  if (!documentRpc.error && Array.isArray(documentRpc.data)) {
    for (const row of documentRpc.data as { id: string; file_name: string; extracted_text: string | null; created_at: string }[]) {
      const text = row.extracted_text ?? "";
      hits.push({
        source: "document",
        id: row.id,
        snippet: `${row.file_name}${text ? `: ${text.slice(0, 240)}` : ""}`,
        created_at: row.created_at,
      });
    }
  } else {
    const { data } = await client
      .from("documents")
      .select("id, file_name, extracted_text, created_at")
      .eq("company_id", companyId)
      .ilike("extracted_text", `%${query}%`)
      .order("created_at", { ascending: false })
      .limit(perStore);
    for (const row of (data ?? []) as { id: string; file_name: string; extracted_text: string | null; created_at: string }[]) {
      const text = row.extracted_text ?? "";
      hits.push({
        source: "document",
        id: row.id,
        snippet: `${row.file_name}${text ? `: ${text.slice(0, 240)}` : ""}`,
        created_at: row.created_at,
      });
    }
  }

  return hits;
}
