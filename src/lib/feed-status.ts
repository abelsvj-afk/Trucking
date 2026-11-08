// ONE place decides what state the news feeds are in and how it is worded, so Home's news strip and the Industry Intelligence page
// (and the Research tab) cannot disagree (live audit 2026-11-07: they told different stories about the same feeds). Pure.

import type { ResearchPageData } from "@/types/entities";
import { cleanResearchError } from "@/lib/research-errors";

export type FeedState = "off" | "setup" | "stale" | "degraded" | "ok";

export interface FeedStatus {
  state: FeedState;
  /** One plain sentence, the same wherever it appears. */
  text: string;
  /** Sources that are currently failing, by name (cleaned). */
  failing: string[];
}

export const FEED_OFF_TEXT = "News is off — the research engine is turned off in Settings.";
export const FEED_SETUP_TEXT = "The research engine hasn't run yet — it needs its one-time setup before headlines appear.";
export const FEED_STALE_TEXT = "The research runner hasn't checked in for over a day — headlines may be behind.";

export function feedStatus(page: Pick<ResearchPageData, "engine_enabled" | "runner" | "watchers"> | null): FeedStatus {
  if (page === null) return { state: "off", text: "News status is unavailable right now.", failing: [] };
  if (!page.engine_enabled) return { state: "off", text: FEED_OFF_TEXT, failing: [] };
  if (page.runner === null || page.runner.last_tick_at === null) {
    return { state: "setup", text: FEED_SETUP_TEXT, failing: [] };
  }
  if (page.runner.stale) {
    return { state: "stale", text: FEED_STALE_TEXT, failing: [] };
  }
  const failing = (page.watchers ?? [])
    .filter((w) => w.last_error || (w.last_status ?? "").toLowerCase().includes("error") || (w.last_status ?? "").toLowerCase() === "failure")
    .map((w) => w.watcher_key.replace(/_/g, " "));
  if (failing.length > 0) {
    return { state: "degraded", text: `News is running, but ${failing.length === 1 ? "one source is" : `${failing.length} sources are`} not answering (${failing.join(", ")}). The others are fine.`, failing };
  }
  return { state: "ok", text: "News is running and every source is answering.", failing: [] };
}

/** Cleaned reason for one failing watcher, for the Research tab. */
export const watcherReason = (lastError: string | null): string | null => (lastError ? cleanResearchError(lastError) : null);
