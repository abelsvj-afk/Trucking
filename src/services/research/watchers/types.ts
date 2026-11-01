// Deep Research Engine watchers (docs/design/research-engine.md §2).
// A watcher polls one free/public source and returns normalized
// pressure signals. Everything a watcher returns is untrusted external
// content (CLAUDE.md) - data to store and summarize, never instructions.

/** One piece of source evidence a signal (and later a briefing) cites. */
export interface ResearchSourceItem {
  title: string;
  url: string;
  publishedAt: string | null;
  summary: string | null;
}

/** A normalized pressure signal, ready to insert into research_signals. */
export interface PressureSignal {
  watcherKey: string;
  kind: string;
  topic: string;
  /** 0..1 - how hard this signal should push the trigger engine. */
  magnitude: number;
  summary: string;
  items: ResearchSourceItem[];
  /** Structured measurements the trigger engine reads (e.g. { wowPct: 4.25 } for diesel) - thresholds never parse prose. */
  data: Record<string, unknown>;
  /** Unique per source-state, so re-polling never double-signals. */
  dedupeKey: string;
  observedAt: string;
}

export type WatcherStatus = "ok" | "error" | "skipped";

export interface WatcherResult {
  watcherKey: string;
  status: WatcherStatus;
  /** Set on error/skipped - recorded in research_watcher_state, shown on the Research page. Never silent. */
  message: string | null;
  signals: PressureSignal[];
  /** Merged into research_watcher_state.state for this watcher. */
  state: Record<string, unknown>;
}

export interface Watcher {
  key: string;
  /** `state` is this watcher's persisted bag from research_watcher_state. */
  poll(state: Record<string, unknown>): Promise<WatcherResult>;
}

/** Tracked topic clusters - shared by the news-burst watcher and the federal-register keyword read. */
export const TRACKED_TOPICS = ["fuel", "rates", "regulation", "carriers", "technology"] as const;
export type TrackedTopic = (typeof TRACKED_TOPICS)[number];

const TOPIC_KEYWORDS: Record<TrackedTopic, string[]> = {
  fuel: ["diesel", "fuel", "oil price", "gas price", "opec"],
  rates: ["spot rate", "freight rate", "load board", "freight volume", "truckload demand", "capacity crunch"],
  regulation: [
    "hours of service",
    "hos rule",
    "eld",
    "speed limiter",
    "clearinghouse",
    "insurance minimum",
    "emissions rule",
    "fmcsa",
    "broker transparency",
  ],
  carriers: ["bankruptcy", "layoff", "layoffs", "shutdown", "closes", "acquisition", "merger"],
  technology: ["electric truck", "electric semi", "autonomous truck", "self-driving truck", "ev truck", "charging"],
};

/** Returns every tracked topic whose keywords appear in the text. */
export function matchTrackedTopics(text: string): TrackedTopic[] {
  const hay = text.toLowerCase();
  return TRACKED_TOPICS.filter((topic) => TOPIC_KEYWORDS[topic].some((kw) => hay.includes(kw)));
}
