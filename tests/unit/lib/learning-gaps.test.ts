// Learning-agenda gap detection (docs/design/autonomous-research.md
// §4): freshness-driven, deduped by open proposals, and honest about
// scope - watcher-fed topics going dark is a plumbing problem for
// the health watchdog, never a research proposal.

import { describe, expect, it } from "vitest";
import { detectLearningGaps, type TopicKnowledgeState } from "@/lib/learning-gaps";
import type { WatchTopic } from "@/lib/watch-topics";

const NOW = new Date("2026-11-09T17:00:00Z");
const FRESH = "2026-11-09T12:00:00Z";
const ANCIENT = "2026-05-01T12:00:00Z";

function state(topic: WatchTopic, latestObservedAt: string | null, hasOpenProposal = false): TopicKnowledgeState {
  return { topic, latestObservedAt, hasOpenProposal };
}

function all(latest: string | null): TopicKnowledgeState[] {
  return (["own_business", "industry", "crypto", "authority_pathways", "build_plan"] as WatchTopic[]).map((t) =>
    state(t, latest),
  );
}

describe("detectLearningGaps", () => {
  it("proposes baselines for the research-fed topics when nothing is stored", () => {
    const gaps = detectLearningGaps(all(null), NOW);
    const topics = gaps.map((g) => g.watchTopic);
    expect(topics).toContain("authority_pathways");
    expect(topics).toContain("build_plan");
    expect(topics).toContain("industry");
    expect(gaps.every((g) => g.kind === "baseline")).toBe(true);
  });

  it("never proposes research for watcher-fed topics (own business, crypto) going dark", () => {
    const gaps = detectLearningGaps(all(null), NOW);
    expect(gaps.map((g) => g.watchTopic)).not.toContain("own_business");
    expect(gaps.map((g) => g.watchTopic)).not.toContain("crypto");
  });

  it("proposes a refresh when stored knowledge has gone stale, crypto included", () => {
    const states = all(FRESH);
    states[2] = state("crypto", ANCIENT); // crypto index in the all() order above
    states[3] = state("authority_pathways", ANCIENT);
    const gaps = detectLearningGaps(states, NOW);
    expect(gaps.map((g) => g.watchTopic).sort()).toEqual(["authority_pathways", "crypto"]);
    expect(gaps.every((g) => g.kind === "refresh")).toBe(true);
  });

  it("stays quiet when everything is current", () => {
    expect(detectLearningGaps(all(FRESH), NOW)).toEqual([]);
  });

  it("dedupes against open proposals", () => {
    const states = all(null);
    states[3] = state("authority_pathways", null, true);
    const gaps = detectLearningGaps(states, NOW);
    expect(gaps.map((g) => g.watchTopic)).not.toContain("authority_pathways");
  });

  it("carries a plain-words reason on every proposal", () => {
    for (const gap of detectLearningGaps(all(null), NOW)) {
      expect(gap.topic.length).toBeGreaterThan(10);
      expect(gap.reason.length).toBeGreaterThan(20);
    }
  });
});
