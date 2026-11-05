// Lane 2 (Abel Intelligence Upgrade, Phase B) — the night shift
// (design §3.6). A scheduled consolidation pass over one company:
//
// 1. Embed memories/turns that don't have vectors yet (best-effort;
//    needs an embedding provider + migration 00029).
// 2. Refresh the rolling weekly conversation summaries.
// 3. Stage semantic candidates found in recent conversation as
//    MORNING PROPOSALS (bot_pending_actions) - it NEVER saves a
//    memory directly and never auto-promotes anything. The owner
//    is the judge; his yes/no machinery decides.
// 4. Near-duplicates of current facts are staged as UPDATE
//    proposals ("change X to Y?"); near-identical candidates are
//    dropped as already-known.
// 5. Record the run + a one-line report (surfaced to the owner by
//    the scheduler when there's anything to say; silence when not).
//
// Kill switch: the memory_consolidation capability (Settings),
// checked before ANY write - off means no writes at all (design
// Phase B acceptance #4).

import type { SupabaseClient } from "@supabase/supabase-js";
import { getEmbeddingProvider, toVectorLiteral, type EmbeddingProvider } from "./embeddings";
import { isMissingColumnError } from "./tool-helpers";
import { tokenSimilarity } from "./memory-lifecycle";
import { refreshConversationSummaries, type SummarizeTurns } from "./summaries";

export const MEMORY_CONSOLIDATION_CAPABILITY = "memory_consolidation";

/** Candidate similarity bands: at/above DUP = already known, drop; at/above UPDATE (but different text) = stage as an update proposal; below = a genuinely new fact. UPDATE sits at 0.4 because the design's canonical update - "Maria settles on Fridays" -> "...on Thursdays" - scores exactly 0.5 under Jaccard (3 content tokens, 1 changed); the band must contain it. */
export const DUPLICATE_SIMILARITY = 0.9;
export const UPDATE_SIMILARITY = 0.4;

export interface ConsolidationDeps {
  client: SupabaseClient;
  companyId: string;
  /** Same capability check the store exposes (global switch + capability row). Injected so tests drive it directly. */
  isEnabled: () => Promise<boolean>;
  /** Model step: pull durable candidate facts out of recent turns. Injected (production wires the AI provider). */
  extractCandidates: (turns: { role: string; text: string }[]) => Promise<string[]>;
  summarize: SummarizeTurns;
  embedder?: EmbeddingProvider | null;
  now?: Date;
}

export interface ConsolidationResult {
  ran: boolean;
  reason?: string;
  embedded: number;
  summariesRefreshed: number;
  proposalsStaged: number;
  updatesStaged: number;
  duplicatesDropped: number;
  report: string | null;
}

const EMBED_BATCH = 50;
const CANDIDATE_TURN_WINDOW = 60;

/** Newest consolidation_runs.ran_at for the company, or null (never ran - or the table isn't readable yet: pre-00032 the due check treats unreadable as due, and runConsolidation's own run-row insert tolerates the missing table). */
export async function latestConsolidationRunAt(
  client: SupabaseClient,
  companyId: string,
): Promise<string | null> {
  const { data } = await client
    .from("consolidation_runs")
    .select("ran_at")
    .eq("company_id", companyId)
    .order("ran_at", { ascending: false })
    .limit(1);
  const ranAt = (data ?? [])[0]?.ran_at as string | undefined;
  return typeof ranAt === "string" ? ranAt : null;
}

/**
 * CD-1 staleness surface: the night shift's runs are due every
 * 20h, so a healthy system never goes 30h without one. Older than
 * that (or never ran) = stale - the "What Abel remembers" page
 * shows a banner, because a consolidation that silently stopped
 * (app asleep for days - the F-020 pattern) must be VISIBLE
 * somewhere the owner actually looks. Never throws: an unreadable
 * runs table (migration 00032 not applied) reports known=false -
 * staleness is unknowable then, not "fine".
 */
export const CONSOLIDATION_STALE_AFTER_MS = 30 * 60 * 60 * 1000;

export interface ConsolidationHealth {
  known: boolean;
  lastRanAt: string | null;
  hoursSinceLastRun: number | null;
  stale: boolean;
}

export async function checkConsolidationHealth(
  client: SupabaseClient,
  companyId: string,
  now: Date = new Date(),
): Promise<ConsolidationHealth> {
  const { data, error } = await client
    .from("consolidation_runs")
    .select("ran_at")
    .eq("company_id", companyId)
    .order("ran_at", { ascending: false })
    .limit(1);
  if (error) return { known: false, lastRanAt: null, hoursSinceLastRun: null, stale: false };
  const lastRanAt = ((data ?? [])[0]?.ran_at as string | undefined) ?? null;
  if (!lastRanAt) return { known: true, lastRanAt: null, hoursSinceLastRun: null, stale: true };
  const ageMs = now.getTime() - new Date(lastRanAt).getTime();
  return {
    known: true,
    lastRanAt,
    hoursSinceLastRun: ageMs / (60 * 60 * 1000),
    stale: ageMs > CONSOLIDATION_STALE_AFTER_MS,
  };
}

async function embedUnembedded(
  client: SupabaseClient,
  companyId: string,
  embedder: EmbeddingProvider,
): Promise<number> {
  let embedded = 0;
  for (const [table, textColumn] of [
    ["bot_memories", "content"],
    ["telegram_messages", "text"],
  ] as const) {
    const { data, error } = await client
      .from(table)
      .select(`id, ${textColumn}`)
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .is("embedding", null)
      .order("created_at", { ascending: true })
      .limit(EMBED_BATCH);
    if (error) {
      if (isMissingColumnError(error)) continue;
      throw new Error(error.message);
    }
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    if (rows.length === 0) continue;
    const vectors = await embedder.embed(rows.map((row) => String(row[textColumn] ?? "")));
    for (let i = 0; i < rows.length; i += 1) {
      const vector = vectors[i];
      if (!vector) continue;
      const { error: updateError } = await client
        .from(table)
        .update({ embedding: toVectorLiteral(vector), embedding_model: embedder.model })
        .eq("id", String(rows[i]!.id))
        .eq("company_id", companyId);
      if (!updateError) embedded += 1;
    }
  }
  return embedded;
}

export async function runConsolidation(deps: ConsolidationDeps): Promise<ConsolidationResult> {
  const idle: ConsolidationResult = {
    ran: false,
    embedded: 0,
    summariesRefreshed: 0,
    proposalsStaged: 0,
    updatesStaged: 0,
    duplicatesDropped: 0,
    report: null,
  };

  // Kill switch first, before any read-for-write or write at all.
  if (!(await deps.isEnabled())) {
    return { ...idle, reason: "memory_consolidation capability is off" };
  }

  const { client, companyId } = deps;
  const embedder = deps.embedder === undefined ? getEmbeddingProvider() : deps.embedder;

  const embedded = embedder ? await embedUnembedded(client, companyId, embedder) : 0;
  const summariesRefreshed = await refreshConversationSummaries(client, companyId, deps.summarize, deps.now);

  // Candidates from recent conversation (the turns since yesterday,
  // bounded) - facts he stated in chat but never saved as memories.
  const since = new Date((deps.now ?? new Date()).getTime() - 36 * 60 * 60 * 1000).toISOString();
  const { data: turnRows, error: turnError } = await client
    .from("telegram_messages")
    .select("role, text, created_at")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(CANDIDATE_TURN_WINDOW);
  if (turnError) throw new Error(turnError.message);
  const turns = ((turnRows ?? []) as { role: string; text: string }[]).reverse();

  const candidates = turns.length > 0 ? await deps.extractCandidates(turns) : [];

  let proposalsStaged = 0;
  let updatesStaged = 0;
  let duplicatesDropped = 0;

  if (candidates.length > 0) {
    const { data: currentRows, error: currentError } = await client
      .from("bot_memories")
      .select("id, kind, content")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .is("valid_to", null)
      .limit(1000);
    let current = (currentRows ?? []) as { id: string; kind: string; content: string }[];
    if (currentError) {
      if (!isMissingColumnError(currentError)) throw new Error(currentError.message);
      const retry = await client
        .from("bot_memories")
        .select("id, kind, content")
        .eq("company_id", companyId)
        .is("deleted_at", null)
        .limit(1000);
      if (retry.error) throw new Error(retry.error.message);
      current = (retry.data ?? []) as { id: string; kind: string; content: string }[];
    }

    for (const candidate of candidates) {
      const text = candidate.trim();
      if (!text) continue;
      let best: { row: (typeof current)[number]; similarity: number } | null = null;
      for (const row of current) {
        const similarity = tokenSimilarity(text, row.content);
        if (!best || similarity > best.similarity) best = { row, similarity };
      }
      if (best && best.similarity >= DUPLICATE_SIMILARITY) {
        duplicatesDropped += 1;
        continue;
      }
      const isUpdate = best !== null && best.similarity >= UPDATE_SIMILARITY;
      const args: Record<string, unknown> = { kind: "fact", content: text };
      let summary: string;
      if (isUpdate && best) {
        args.supersedes_id = best.row.id;
        summary = `Update a remembered fact: change "${best.row.content}" to "${text}"? (from your recent messages)`;
        updatesStaged += 1;
      } else {
        summary = `Remember this? "${text}" (from your recent messages)`;
        proposalsStaged += 1;
      }
      const { error: stageError } = await client.from("bot_pending_actions").insert({
        company_id: companyId,
        channel: "telegram",
        tool_name: "save_memory",
        arguments: args,
        summary,
      });
      if (stageError) throw new Error(stageError.message);
    }
  }

  const stagedTotal = proposalsStaged + updatesStaged;
  const report =
    stagedTotal > 0 || summariesRefreshed > 0
      ? `Night shift: refreshed ${summariesRefreshed} weekly ${summariesRefreshed === 1 ? "summary" : "summaries"}, ` +
        `staged ${stagedTotal} memory ${stagedTotal === 1 ? "proposal" : "proposals"} for your yes/no` +
        `${updatesStaged > 0 ? ` (${updatesStaged} of them update an older fact)` : ""}` +
        `${duplicatesDropped > 0 ? `, dropped ${duplicatesDropped} you already had` : ""}. Nothing was saved without your say.`
      : null;

  const { error: runError } = await client.from("consolidation_runs").insert({
    company_id: companyId,
    report,
    proposals_staged: stagedTotal,
  });
  if (runError && !(/consolidation_runs/.test(runError.message) && /does not exist|could not find/i.test(runError.message))) {
    throw new Error(runError.message);
  }

  return {
    ran: true,
    embedded,
    summariesRefreshed,
    proposalsStaged,
    updatesStaged,
    duplicatesDropped,
    report,
  };
}
