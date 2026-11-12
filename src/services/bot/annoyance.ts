// Frontier 2-A — the annoyance signal: how much he has been
// turning down one kind of suggestion lately.
//
// Computed in code from bot_proposal_outcomes rows (the same feed
// learning.ts summarizes), never a model judgment. Declined =
// dropped | corrected; 90-day window; recency-weighted like
// learning.ts (answers newer than 30 days count double).
//
// The signal is 0 when there is no history for the category, and
// 0 until a pattern has earned it (at least 3 declines) — one or
// two drops are not a pattern yet. Above that it is the
// recency-weighted declined share, 0..1: the number the future
// Frontier 5 gate consumes as its annoyance term.
//
// HONEST LIMIT: today's feed is declined proposals by signature.
// A card Dismiss tap writes nothing by design (dispatch-bot), so
// Dismiss taps do not feed this signal yet — digest-dismiss
// recording is a named Frontier 5 follow-up, not smuggled in here.

import { WINDOW_DAYS, type OutcomeRow } from "./learning";

export type { OutcomeRow };

const DAY_MS = 86_400_000;
/** Declines below this count are noise, not a pattern. */
export const ANNOYANCE_MIN_DECLINES = 3;

/**
 * Annoyance for one category (a signature, e.g. `digest/morning`):
 * 0..1, 0 = no signal. Pure.
 */
export function annoyanceSignal(category: string, rows: OutcomeRow[], now: Date): number {
  let wDeclined = 0;
  let wApproved = 0;
  let declined = 0;
  for (const row of rows) {
    if (row.signature !== category) continue;
    if (row.outcome !== "approved" && row.outcome !== "dropped" && row.outcome !== "corrected") continue;
    const age = (now.getTime() - Date.parse(row.created_at)) / DAY_MS;
    if (!Number.isFinite(age) || age > WINDOW_DAYS) continue;
    const weight = age <= 30 ? 2 : 1;
    if (row.outcome === "approved") {
      wApproved += weight;
    } else {
      declined += 1;
      wDeclined += weight;
    }
  }
  if (declined < ANNOYANCE_MIN_DECLINES) return 0;
  const total = wApproved + wDeclined;
  return total === 0 ? 0 : wDeclined / total;
}

/** One plain-words line for a nonzero signal, or null. */
export function annoyanceLine(category: string, signal: number): string | null {
  if (signal <= 0) return null;
  const pct = Math.round(signal * 100);
  return `He has been turning down ${category} suggestions lately (annoyance ${pct}%) — suggest less of it, and only when he asks.`;
}
