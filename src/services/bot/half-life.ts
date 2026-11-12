// Frontier 2 (Remember better) — per-kind half-lives in retrieval.
//
// The recency term uses kind half-lives (plan § Frontier 2):
// episodes ~7d, preferences ~90d, facts 365d, constraints ∞.
// decay = 0.5^(age / halfLife); ∞ half-life = 1 (never decays).
// Decay RANKS, never deletes: a decayed row stays in the store
// and stays retrievable — it just scores lower.
//
// Kind mapping (documented — the store has no reliable preference
// marker):
// - agent_episodes rows count as episodes (7d), whatever their kind.
// - bot_memories kinds map by role: fact -> 365d; instruction /
//   person_profile / business_fact -> constraints (∞ — a standing
//   instruction or who-someone-is does not go stale with age);
//   note / expense_hint -> 7d (ephemeral observations).
// - Preferences are `fact` rows whose content IS a preference, and
//   the store carries no marker that distinguishes them from other
//   facts, so `fact` maps to 365d and this is noted, not guessed.
//   If a preference marker is ever added, map it to 90d here.

export type HalfLifeKind = "episode" | "preference" | "fact" | "constraint";

const DAY_MS = 86_400_000;

export const HALF_LIFE_MS: Record<HalfLifeKind, number> = {
  episode: 7 * DAY_MS,
  preference: 90 * DAY_MS,
  fact: 365 * DAY_MS,
  constraint: Number.POSITIVE_INFINITY,
};

/** Decay weight for one row: 1 when fresh, halving every half-life. Pure. */
export function halfLifeWeight(kind: HalfLifeKind, ageMs: number): number {
  const halfLife = HALF_LIFE_MS[kind] ?? HALF_LIFE_MS.fact;
  if (!Number.isFinite(halfLife)) return 1;
  if (ageMs <= 0) return 1;
  return Math.pow(0.5, ageMs / halfLife);
}

/**
 * Half-life for a stored row's kind. `episode` is the
 * agent_episodes kind; every other string is a bot_memories kind.
 */
export function memoryKindHalfLifeMs(kind: string): number {
  switch (kind) {
    case "episode":
      return HALF_LIFE_MS.episode;
    case "preference":
      return HALF_LIFE_MS.preference;
    case "constraint":
    case "instruction":
    case "person_profile":
    case "business_fact":
      return HALF_LIFE_MS.constraint;
    case "note":
    case "expense_hint":
      return HALF_LIFE_MS.episode;
    case "fact":
    default:
      return HALF_LIFE_MS.fact;
  }
}

/** One scored row, ready for decay re-ranking. */
export interface HalfLifeRow {
  id: string;
  kind: string;
  created_at: string;
  /** The pre-decay score (RRF score, or a fallback rank score). */
  score: number;
}

export interface DecayedRow extends HalfLifeRow {
  decayedScore: number;
  weight: number;
}

/** Decay one score by the row's kind and age. Pure. */
export function applyHalfLife(score: number, kind: string, ageMs: number): number {
  const halfLife = memoryKindHalfLifeMs(kind);
  if (!Number.isFinite(halfLife)) return score;
  if (ageMs <= 0) return score;
  return score * Math.pow(0.5, ageMs / halfLife);
}

/**
 * Re-rank scored rows by score × half-life weight (highest first).
 * Stable: equal decayed scores keep input order, so the ranking is
 * deterministic for a seeded set. Nothing is dropped.
 */
export function rerankWithHalfLife<T extends HalfLifeRow>(rows: T[], nowMs: number = Date.now()): (T & DecayedRow)[] {
  const decorated = rows.map((row, index) => {
    const ageMs = nowMs - Date.parse(row.created_at);
    const halfLife = memoryKindHalfLifeMs(row.kind);
    const weight = !Number.isFinite(halfLife) || ageMs <= 0 ? 1 : Math.pow(0.5, ageMs / halfLife);
    return { ...row, weight, decayedScore: row.score * weight, index };
  });
  decorated.sort((a, b) => b.decayedScore - a.decayedScore || a.index - b.index);
  return decorated.map(({ index: _index, ...row }) => row) as (T & DecayedRow)[];
}
