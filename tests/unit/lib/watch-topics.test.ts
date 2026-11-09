// Standing watch topics (docs/design/autonomous-research.md): the
// registry names exactly the five owner-spec topics, freshness
// boundaries come from each topic's own window, and dates render in
// America/New_York - never UTC.

import { describe, expect, it } from "vitest";
import {
  easternShortDate,
  isWatchTopic,
  knowledgeFreshness,
  watchTopicForSignal,
  WATCH_TOPIC_DEFS,
  WATCH_TOPICS,
} from "@/lib/watch-topics";

describe("watch topic registry", () => {
  it("names exactly the five standing topics from the spec", () => {
    expect([...WATCH_TOPICS]).toEqual([
      "own_business",
      "industry",
      "crypto",
      "authority_pathways",
      "build_plan",
    ]);
    for (const key of WATCH_TOPICS) {
      expect(WATCH_TOPIC_DEFS[key].why.length).toBeGreaterThan(20);
      expect(WATCH_TOPIC_DEFS[key].staleDays).toBeGreaterThan(WATCH_TOPIC_DEFS[key].freshDays);
    }
  });

  it("recognizes only registry keys", () => {
    expect(isWatchTopic("crypto")).toBe(true);
    expect(isWatchTopic("stocks")).toBe(false);
    expect(isWatchTopic("market")).toBe(false);
  });

  it("maps watcher signals to standing topics", () => {
    expect(watchTopicForSignal({ watcherKey: "coingecko_crypto", topic: "crypto" })).toBe("crypto");
    expect(watchTopicForSignal({ watcherKey: "eia_diesel", topic: "fuel" })).toBe("industry");
    expect(watchTopicForSignal({ watcherKey: "federal_register", topic: "regulation" })).toBe("industry");
    expect(watchTopicForSignal({ watcherKey: "fred_market", topic: "market" })).toBe("industry");
  });
});

describe("knowledgeFreshness", () => {
  const now = new Date("2026-11-09T17:00:00Z"); // Nov 9, noon Eastern

  it("reports none when nothing is stored", () => {
    const read = knowledgeFreshness("industry", null, now);
    expect(read.level).toBe("none");
    expect(read.label).toContain("nothing stored");
  });

  it("calls a same-day crypto fact current", () => {
    const read = knowledgeFreshness("crypto", "2026-11-09T12:00:00Z", now);
    expect(read.level).toBe("current");
    expect(read.label).toContain("Nov 9");
  });

  it("ages an industry fact on the industry window, not the crypto one", () => {
    // 10 days old: stale for crypto (7), only aging for industry (fresh 7 / stale 21).
    const at = "2026-10-30T12:00:00Z";
    expect(knowledgeFreshness("crypto", at, now).level).toBe("stale");
    expect(knowledgeFreshness("industry", at, now).level).toBe("aging");
  });

  it("marks an old authority fact stale and says background only", () => {
    const read = knowledgeFreshness("authority_pathways", "2026-06-01T12:00:00Z", now);
    expect(read.level).toBe("stale");
    expect(read.label).toContain("background only");
  });

  it("renders Eastern dates", () => {
    // 2026-11-09T02:00:00Z is Nov 8 in New York.
    expect(easternShortDate("2026-11-09T02:00:00Z")).toBe("Nov 8");
  });
});
