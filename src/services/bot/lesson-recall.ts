// Frontier 2 — pre-action recall: before composing an answer
// with a recommendation (or a proactive candidate), embed the
// situation and pull the top-K agent lessons into reasoning
// context ("what I've learned about working with him").
//
// A high-confidence `hurt` lesson is exposed as a NUMBER on the
// result (maxHurtConfidence) — the shape the future Frontier 5
// gate consumes as its annoyance term. This module shapes the
// data; it does NOT build the gate.
//
// Best-effort by contract: recall never breaks a turn — no
// lessons (or a failed read) yields an empty result, never a throw.

import type { SupabaseClient } from "@supabase/supabase-js";
import { annoyanceSignal } from "./annoyance";
import { searchEpisodes, type EpisodeRow } from "./episodes";
import type { EmbeddingProvider } from "./embeddings";
import type { OutcomeRow } from "./learning";

export interface RecalledLesson {
  id: string;
  kind: string;
  summary: string;
  lesson: string;
  valence: string | null;
  confidence: number | null;
  created_at: string;
  /** The evidence behind the lesson (its situation text). */
  evidence: string | null;
}

export interface LessonRecall {
  lessons: RecalledLesson[];
  /** The context block, or null when there is nothing to recall. */
  block: string | null;
  /**
   * The highest confidence among high-confidence (>= 0.7) `hurt`
   * lessons recalled — the numeric annoyance term the Frontier 5
   * gate will consume. 0 when no such lesson was recalled.
   */
  maxHurtConfidence: number;
  /** Annoyance signal for the candidate's category (0 when no category/outcomes were given). */
  annoyance: number;
}

export const LESSON_RECALL_LIMIT = 6;
/** A `hurt` lesson counts as high-confidence at this bar. */
export const HIGH_CONFIDENCE_HURT = 0.7;

export async function recallLessons(
  client: SupabaseClient,
  companyId: string,
  situation: string,
  embedder: EmbeddingProvider | null,
  options: {
    limit?: number;
    /** Candidate category (a signature, e.g. `digest/morning`) — its annoyance signal rides the block when > 0. */
    category?: string;
    outcomeRows?: OutcomeRow[];
    now?: Date;
  } = {},
): Promise<LessonRecall> {
  const empty: LessonRecall = { lessons: [], block: null, maxHurtConfidence: 0, annoyance: 0 };
  if (!situation.trim()) return empty;
  let hits: (EpisodeRow & { score: number; decayedScore: number })[];
  try {
    hits = await searchEpisodes(client, companyId, situation, {
      embedder,
      limit: options.limit ?? LESSON_RECALL_LIMIT,
      now: options.now,
    });
  } catch (err) {
    console.error("[lesson-recall] episode search failed (recall skipped, turn unaffected)", err);
    return empty;
  }
  const withLessons = hits.filter((h) => (h.lesson ?? "").trim().length > 0);
  // High-confidence `hurt` first (the lessons that cost him),
  // then the rest by decayed relevance.
  const sorted = [...withLessons].sort((a, b) => {
    const aHurt = a.valence === "hurt" && (a.confidence ?? 0) >= HIGH_CONFIDENCE_HURT ? 1 : 0;
    const bHurt = b.valence === "hurt" && (b.confidence ?? 0) >= HIGH_CONFIDENCE_HURT ? 1 : 0;
    return bHurt - aHurt || b.decayedScore - a.decayedScore;
  });
  const lessons: RecalledLesson[] = sorted.map((h) => ({
    id: h.id,
    kind: h.kind,
    summary: h.summary,
    lesson: (h.lesson ?? "").trim(),
    valence: h.valence,
    confidence: h.confidence,
    created_at: h.created_at,
    evidence: h.situation,
  }));
  const maxHurtConfidence = lessons.reduce(
    (max, l) => (l.valence === "hurt" && (l.confidence ?? 0) >= HIGH_CONFIDENCE_HURT ? Math.max(max, l.confidence ?? 0) : max),
    0,
  );
  const now = options.now ?? new Date();
  const annoyance =
    options.category && options.outcomeRows ? annoyanceSignal(options.category, options.outcomeRows, now) : 0;
  if (lessons.length === 0 && annoyance <= 0) return empty;
  const lines = ["WHAT I'VE LEARNED ABOUT WORKING WITH HIM (from my own record of what worked and what didn't — apply it, don't re-derive it):"];
  for (const l of lessons) {
    lines.push(`- ${l.lesson} (from: ${l.summary}${l.evidence ? ` — ${l.evidence}` : ""})`);
  }
  if (annoyance > 0) {
    lines.push(`- He has been turning down ${options.category} suggestions lately (annoyance ${Math.round(annoyance * 100)}%) — suggest less of it, and only when he asks.`);
  }
  return { lessons, block: lines.join("\n"), maxHurtConfidence, annoyance };
}
