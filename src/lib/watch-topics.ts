// Standing watch topics (docs/design/autonomous-research.md): the
// five things Abel keeps awareness of for the owner, in his words and
// plain words, each with the sources that feed it and how long a fact
// about it stays "current". One registry, read by the knowledge
// writers, the learning-agenda pass, the bot tools, and the Research
// page - so what Abel says he's watching can never drift from what
// the engine actually watches. Pure: no I/O, no clock of its own.

export const WATCH_TOPICS = [
  "own_business",
  "industry",
  "crypto",
  "authority_pathways",
  "build_plan",
] as const;

export type WatchTopic = (typeof WATCH_TOPICS)[number];

export interface WatchTopicDef {
  key: WatchTopic;
  /** Short name for chat and the Research page. */
  label: string;
  /** Why Abel watches it, in plain words - he says this verbatim when asked what he's watching and why. */
  why: string;
  /** Where the knowledge comes from (named in answers that cite it). */
  sources: string;
  /** A fact newer than this many days is "current" for this topic. */
  freshDays: number;
  /** A fact older than this many days is "stale" - background only, quoted with its date, never as current. */
  staleDays: number;
}

export const WATCH_TOPIC_DEFS: Record<WatchTopic, WatchTopicDef> = {
  own_business: {
    key: "own_business",
    label: "Your business",
    why: "So advice fits how your operation is actually going - your miles, your loads, your money - not a generic driver's.",
    sources: "Your own records in the app (loads, expenses, pay terms)",
    freshDays: 2,
    staleDays: 7,
  },
  industry: {
    key: "industry",
    label: "The trucking industry",
    why: "Diesel, freight rates, regulation, and carrier news decide what a load is worth and what's about to change on the road.",
    sources: "EIA diesel, Federal Register (FMCSA), industry news feeds, state law tracker, weather alerts",
    freshDays: 7,
    staleDays: 21,
  },
  crypto: {
    key: "crypto",
    label: "Crypto (awareness only)",
    why: "Your BTC and XRP sit behind your Coinbase loans, so a big move changes your cushion. Awareness only - never trading advice, and it never touches the loans.",
    sources: "CoinGecko public prices (free)",
    freshDays: 2,
    staleDays: 7,
  },
  authority_pathways: {
    key: "authority_pathways",
    label: "Your path to your own truck + authority",
    why: "The costs and steps to your own truck and MC authority change over time; keeping them current keeps the plan real.",
    sources: "Deep Research runs on approved topics (FMCSA, state, and cost sources)",
    freshDays: 30,
    staleDays: 90,
  },
  build_plan: {
    key: "build_plan",
    label: "Your build plan",
    why: "Your phased plan - drive, save, own truck, own authority under your LLC - is the yardstick every suggestion gets measured against, so it fits the phase you're in.",
    sources: "What you've told Abel about your plan, plus your records",
    freshDays: 30,
    staleDays: 90,
  },
};

export function isWatchTopic(value: string): value is WatchTopic {
  return (WATCH_TOPICS as readonly string[]).includes(value);
}

export function watchTopicDef(key: string): WatchTopicDef | null {
  return isWatchTopic(key) ? WATCH_TOPIC_DEFS[key] : null;
}

/**
 * Which standing topic a watcher signal belongs to. Watcher topics
 * are the TRACKED_TOPICS vocabulary (fuel/rates/regulation/…) - all
 * of those are the industry environment. The crypto snapshot is the
 * one new domain. Anything unrecognized returns null (not distilled).
 */
export function watchTopicForSignal(signal: { watcherKey: string; topic: string }): WatchTopic | null {
  if (signal.watcherKey === "coingecko_crypto") return "crypto";
  return "industry";
}

export type KnowledgeFreshness = "current" | "aging" | "stale" | "none";

export interface FreshnessRead {
  level: KnowledgeFreshness;
  /** Whole days between the fact's date and now, on the owner's clock. Null when there is no fact. */
  ageDays: number | null;
  /** The one-line plain-words label an answer relays, e.g. "current (as of Nov 8)". */
  label: string;
}

const easternDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

function daysBetweenIso(fromDay: string, toDay: string): number {
  const from = Date.parse(`${fromDay}T12:00:00Z`);
  const to = Date.parse(`${toDay}T12:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

/** "Nov 8" in America/New_York - the only date shape an owner-facing freshness label uses. */
export function easternShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an unknown date";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
}

/**
 * Freshness of one knowledge fact for its topic. `observedAt` null =
 * nothing stored yet ("none"). Boundaries come from the topic def -
 * a diesel price and an authority cost honestly age at different
 * speeds, so there is no single global staleness line.
 */
export function knowledgeFreshness(topic: WatchTopic, observedAt: string | null, now: Date = new Date()): FreshnessRead {
  if (!observedAt) {
    return { level: "none", ageDays: null, label: "nothing stored yet" };
  }
  const observed = new Date(observedAt);
  if (Number.isNaN(observed.getTime())) {
    return { level: "none", ageDays: null, label: "nothing stored yet" };
  }
  const def = WATCH_TOPIC_DEFS[topic];
  const ageDays = Math.max(0, daysBetweenIso(easternDay(observed), easternDay(now)));
  const asOf = easternShortDate(observedAt);
  if (ageDays <= def.freshDays) {
    return { level: "current", ageDays, label: `current (as of ${asOf})` };
  }
  if (ageDays <= def.staleDays) {
    return { level: "aging", ageDays, label: `getting old (as of ${asOf}, ${ageDays} days ago)` };
  }
  return { level: "stale", ageDays, label: `stale (as of ${asOf}, ${ageDays} days ago) - background only` };
}
