import { describe, expect, it } from "vitest";
import { buildBannerItems, formatRelativeAge } from "@/lib/news-banner";
import type { ResearchBriefing, ResearchSignal } from "@/types/entities";

const NOW = new Date("2026-11-02T15:00:00Z");

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3600 * 1000).toISOString();
}

function briefing(partial: Partial<ResearchBriefing> & { id: string }): ResearchBriefing {
  return {
    company_id: "c1",
    run_id: null,
    topic: "fuel",
    title: `Briefing ${partial.id}`,
    headline: "one line",
    findings: [],
    what_changed: "",
    counter_move: "",
    takeaway: "",
    unverified: [],
    sources: [],
    confidence: "high",
    telegram_notified_at: null,
    read_at: "2026-11-01T00:00:00Z",
    dismissed_at: null,
    created_at: hoursAgo(1),
    delivery_class: "routine",
    delivery_held_until: null,
    ...partial,
  };
}

function signal(partial: Partial<ResearchSignal> & { id: string }): ResearchSignal {
  return {
    watcher_key: "eia_diesel",
    kind: "fuel_price_observation",
    topic: "fuel",
    magnitude: 0.8,
    summary: `Signal ${partial.id}`,
    items: [],
    observed_at: hoursAgo(1),
    dedupe_key: `k-${partial.id}`,
    ...partial,
  };
}

describe("formatRelativeAge", () => {
  it("formats seconds, minutes, hours, and days", () => {
    expect(formatRelativeAge(hoursAgo(0), NOW)).toBe("just now");
    expect(formatRelativeAge(new Date(NOW.getTime() - 25 * 60000).toISOString(), NOW)).toBe("25m ago");
    expect(formatRelativeAge(hoursAgo(2), NOW)).toBe("2h ago");
    expect(formatRelativeAge(hoursAgo(49), NOW)).toBe("2d ago");
  });
});

describe("buildBannerItems", () => {
  it("returns nothing for an empty payload", () => {
    expect(buildBannerItems({ data: [], signals: [] }, NOW)).toEqual([]);
  });

  it("excludes briefings older than 14 days but keeps the boundary", () => {
    const items = buildBannerItems(
      {
        data: [
          briefing({ id: "old", created_at: hoursAgo(24 * 15) }),
          briefing({ id: "edge", created_at: hoursAgo(24 * 14 - 1) }),
        ],
        signals: [],
      },
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual(["edge"]);
  });

  it("a fresh briefing leads over a signal", () => {
    const items = buildBannerItems(
      {
        data: [briefing({ id: "b1", created_at: hoursAgo(3) })],
        signals: [signal({ id: "s1", magnitude: 1, observed_at: hoursAgo(0.5) })],
      },
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual(["b1", "s1"]);
  });

  it("urgent briefings outrank signals, which outrank trip, which outrank routine", () => {
    const items = buildBannerItems(
      {
        data: [
          briefing({ id: "routine", topic: "market", delivery_class: "routine", created_at: hoursAgo(100) }),
          briefing({ id: "trip", topic: "weather", delivery_class: "trip", created_at: hoursAgo(100) }),
          briefing({ id: "urgent", topic: "regulation", delivery_class: "urgent", created_at: hoursAgo(100) }),
        ],
        signals: [signal({ id: "s1", observed_at: hoursAgo(100) })],
      },
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual(["urgent", "s1", "trip", "routine"]);
  });

  it("a fresh routine briefing still leads an old urgent one (fresh leads, then merge order)", () => {
    const items = buildBannerItems(
      {
        data: [
          briefing({ id: "urgent-old", delivery_class: "urgent", created_at: hoursAgo(100) }),
          briefing({ id: "routine-fresh", delivery_class: "routine", created_at: hoursAgo(2) }),
        ],
        signals: [],
      },
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual(["routine-fresh", "urgent-old"]);
  });

  it("unread briefings break ties upward within a class, then newest first", () => {
    const items = buildBannerItems(
      {
        data: [
          briefing({ id: "read-newer", read_at: "2026-11-02T00:00:00Z", created_at: hoursAgo(90) }),
          briefing({ id: "unread-older", read_at: null, created_at: hoursAgo(100) }),
        ],
        signals: [],
      },
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual(["unread-older", "read-newer"]);
  });

  it("signals order by magnitude x recency, not magnitude alone", () => {
    const items = buildBannerItems(
      {
        data: [],
        signals: [
          signal({ id: "strong-stale", magnitude: 1, observed_at: hoursAgo(70) }),
          signal({ id: "mid-fresh", magnitude: 0.6, observed_at: hoursAgo(1) }),
        ],
      },
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual(["mid-fresh", "strong-stale"]);
  });

  it("caps signals at 4, one topic at 3, and the rotation at 12", () => {
    const topics = ["fuel", "weather", "regulation", "rates", "market"];
    const items = buildBannerItems(
      {
        data: Array.from({ length: 14 }, (_, n) =>
          briefing({ id: `b${n}`, topic: topics[n % topics.length]!, created_at: hoursAgo(100 + n) }),
        ),
        signals: Array.from({ length: 7 }, (_, n) =>
          signal({ id: `s${n}`, topic: topics[n % topics.length]!, magnitude: 0.9 - n * 0.05, observed_at: hoursAgo(100) }),
        ),
      },
      NOW,
    );
    expect(items.length).toBeLessThanOrEqual(12);
    expect(items.filter((i) => i.kind === "signal").length).toBeLessThanOrEqual(4);
    for (const topic of topics) expect(items.filter((i) => i.topic === topic).length).toBeLessThanOrEqual(3);
    // five topics x three each = 15 available, so the 12 cap is what binds
    expect(items).toHaveLength(12);
  });

  it("one topic can't take over the strip: eight fuel stories show three", () => {
    const items = buildBannerItems(
      { data: Array.from({ length: 8 }, (_, n) => briefing({ id: `f${n}`, topic: "fuel", created_at: hoursAgo(100 + n) })), signals: [] },
      NOW,
    );
    expect(items).toHaveLength(3);
  });

  it("maps the item anatomy: briefing sub + unread, signal summary with no sub", () => {
    const items = buildBannerItems(
      {
        data: [briefing({ id: "b1", read_at: null, title: "Diesel jumps", headline: "Up 6%" })],
        signals: [signal({ id: "s1", summary: "Raw pressure" })],
      },
      NOW,
    );
    const b = items.find((i) => i.id === "b1");
    const s = items.find((i) => i.id === "s1");
    expect(b).toMatchObject({ kind: "briefing", headline: "Diesel jumps", sub: "Up 6%", unread: true });
    expect(s).toMatchObject({ kind: "signal", headline: "Raw pressure", sub: null, unread: false });
  });
});
