// Learning-agenda gap detection (docs/design/autonomous-research.md
// §4). Pure and deterministic: given, per standing watch topic, the
// newest knowledge fact's date (or null), decide which research
// topics Abel should PROPOSE to the owner. A gap here never queues a
// run - it files a proposal the owner approves or dismisses (chat or
// Research page), same propose→yes discipline as everything else.
//
// Deliberately freshness-driven only. "He asked about X and Abel had
// nothing" is noticed by Abel in conversation and proposed through
// the propose_learning_topic tool; this module covers what no
// conversation can notice: a watched topic quietly going dark or
// stale in the background.

import {
  knowledgeFreshness,
  WATCH_TOPIC_DEFS,
  WATCH_TOPICS,
  type WatchTopic,
} from "./watch-topics";

export interface TopicKnowledgeState {
  topic: WatchTopic;
  /** ISO time of the newest stored knowledge fact for the topic, or null when none exists. */
  latestObservedAt: string | null;
  /** True when a proposed/queued agenda row already covers this topic (dedupe). */
  hasOpenProposal: boolean;
}

export interface LearningGap {
  watchTopic: WatchTopic;
  /** The research topic as it will be queued on approval - in plain words. */
  topic: string;
  /** Why Abel wants to learn it, in plain words - shown to the owner with the proposal. */
  reason: string;
  kind: "baseline" | "refresh";
}

const BASELINE_TOPICS: Partial<Record<WatchTopic, { topic: string; reason: string }>> = {
  authority_pathways: {
    topic: "Current costs and steps to get his own truck and MC authority",
    reason:
      "He's building toward his own truck and authority, and Abel has nothing stored on what it costs or what the steps are right now. A baseline pass keeps the plan priced in real numbers.",
  },
  build_plan: {
    topic: "What drivers in his position typically save and spend in the first year toward buying a truck",
    reason:
      "His phased plan (drive, save, own truck, own authority) is the yardstick for advice, and Abel has no stored research behind the saving phase yet.",
  },
  industry: {
    topic: "Current trucking industry picture: diesel, spot rates, and regulation changes",
    reason:
      "The industry watch has produced no stored knowledge yet, so Abel is answering load and money questions without the environment in mind.",
  },
};

const REFRESH_TOPICS: Partial<Record<WatchTopic, { topic: string; reason: string }>> = {
  authority_pathways: {
    topic: "Update: costs and steps to get his own truck and MC authority",
    reason:
      "What Abel has stored on the path to his own authority has gone stale - prices and rules from months ago shouldn't steer the plan.",
  },
  build_plan: {
    topic: "Update: saving benchmarks for drivers building toward their first truck",
    reason: "The stored research behind his build plan's saving phase has gone stale.",
  },
  industry: {
    topic: "Update: trucking industry picture - diesel, spot rates, regulation",
    reason: "The stored industry picture has gone stale; a refresh keeps load advice grounded in the current environment.",
  },
  crypto: {
    topic: "Crypto market context for BTC and XRP holders with collateral loans",
    reason:
      "The crypto picture has gone stale. Awareness only - what the market is doing around his collateral, never trading advice.",
  },
};

/**
 * The gaps worth proposing right now. Own-business and crypto are
 * watcher-fed (daily snapshots), so their absence is a plumbing
 * problem the health watchdog reports - never a research proposal.
 * Baseline gaps (nothing stored) outrank refreshes (stale), and the
 * caller's cap applies after sorting.
 */
export function detectLearningGaps(states: TopicKnowledgeState[], now: Date = new Date()): LearningGap[] {
  const byTopic = new Map(states.map((s) => [s.topic, s]));
  const gaps: LearningGap[] = [];

  for (const topic of WATCH_TOPICS) {
    const state = byTopic.get(topic);
    if (!state || state.hasOpenProposal) continue;
    const freshness = knowledgeFreshness(topic, state.latestObservedAt, now);

    if (freshness.level === "none") {
      const baseline = BASELINE_TOPICS[topic];
      if (baseline) gaps.push({ watchTopic: topic, kind: "baseline", ...baseline });
      continue;
    }
    if (freshness.level === "stale") {
      const refresh = REFRESH_TOPICS[topic];
      if (refresh) gaps.push({ watchTopic: topic, kind: "refresh", ...refresh });
    }
  }

  const rank = (g: LearningGap) => (g.kind === "baseline" ? 0 : 1);
  return gaps.sort((a, b) => rank(a) - rank(b));
}

/** The plain-words "why" line for a topic, used when Abel explains a proposal. */
export function gapReasonLabel(gap: LearningGap): string {
  const def = WATCH_TOPIC_DEFS[gap.watchTopic];
  return `${def.label}: ${gap.reason}`;
}
