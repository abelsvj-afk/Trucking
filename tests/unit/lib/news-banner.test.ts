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

  // V78 live check 2026-11-10: the SAME story rendered at two carousel
  // positions — two different signals whose first story is the same
  // article (same URL, slightly different headline casing/punctuation
  // from two watchers) both survived the headline-exact dedupe.
  // Dedupe must key on story identity (canonical URL of the headlined
  // story, then normalized headline), not the raw headline string.
  it("the same story arriving via two signals renders ONCE (dedupe by story identity)", () => {
    const story = {
      title: "FMCSA proposes new broker transparency rule",
      url: "https://www.thetrucker.com/story/fmcsa-broker-rule?utm_source=feed",
      publishedAt: null,
      summary: null,
      imageUrl: null,
    };
    const items = buildBannerItems(
      {
        data: [],
        signals: [
          signal({
            id: "sig-a",
            watcher_key: "gdelt_regulation",
            kind: "news_cluster",
            topic: "regulation",
            magnitude: 0.9,
            summary: "12 regulation news items on 'FMCSA' inside 48h (GDELT)",
            items: [story],
            observed_at: hoursAgo(1),
          }),
          signal({
            id: "sig-b",
            watcher_key: "gdelt_freight",
            kind: "news_cluster",
            topic: "regulation",
            magnitude: 0.7,
            summary: "9 regulation news items on 'broker rules' inside 48h (GDELT)",
            items: [
              {
                ...story,
                title: "FMCSA Proposes New Broker Transparency Rule.",
                url: "https://www.thetrucker.com/story/fmcsa-broker-rule",
              },
            ],
            observed_at: hoursAgo(2),
          }),
        ],
      },
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("sig-a");
  });

  it("the same story arriving once as a signal and once as a briefing renders ONCE", () => {
    const items = buildBannerItems(
      {
        data: [
          briefing({
            id: "b-reg",
            topic: "regulation",
            title: "FMCSA proposes new broker transparency rule",
            created_at: hoursAgo(5),
            delivery_class: "routine",
            findings: [
              {
                claim: "c",
                source_url: "https://www.thetrucker.com/story/fmcsa-broker-rule",
                source_title: "FMCSA proposes new broker transparency rule",
              },
            ],
          }),
        ],
        signals: [
          signal({
            id: "sig-reg",
            watcher_key: "gdelt_regulation",
            kind: "news_cluster",
            topic: "regulation",
            magnitude: 0.9,
            summary: "12 regulation news items on 'FMCSA' inside 48h (GDELT)",
            items: [
              {
                title: "FMCSA proposes new broker transparency rule",
                url: "https://www.thetrucker.com/story/fmcsa-broker-rule",
                publishedAt: null,
                summary: null,
                imageUrl: null,
              },
            ],
            observed_at: hoursAgo(1),
          }),
        ],
      },
      NOW,
    );
    const storyCopies = items.filter((i) => /broker transparency/i.test(i.headline));
    expect(storyCopies).toHaveLength(1);
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

  it("a signal with an image points at OUR endpoint (never the publisher) at the right item index; briefings and image-less signals get none", () => {
    const items = buildBannerItems(
      {
        data: [briefing({ id: "b1", topic: "weather" })],
        signals: [
          signal({
            id: "11111111-1111-4111-8111-111111111111",
            topic: "market",
            items: [
              { title: "t0", url: "https://x.example/0", publishedAt: null, summary: null },
              { title: "t1", url: "https://x.example/1", publishedAt: null, summary: null, imageUrl: "https://cdn.x.example/1.jpg" },
            ],
          }),
          signal({ id: "22222222-2222-4222-8222-222222222222", topic: "rates", items: [{ title: "t", url: "https://x.example/0", publishedAt: null, summary: null }] }),
        ],
      },
      NOW,
    );
    expect(items.find((i) => i.id === "11111111-1111-4111-8111-111111111111")!.imageSrc).toBe(
      "/api/v1/news-image?signal=11111111-1111-4111-8111-111111111111&i=1",
    );
    expect(items.find((i) => i.id === "22222222-2222-4222-8222-222222222222")!.imageSrc).toBeNull();
    expect(items.find((i) => i.id === "b1")!.imageSrc).toBeNull();
    // no publisher URL ever appears in what the banner renders
    expect(JSON.stringify(items)).not.toContain("cdn.x.example");
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

describe("one instance per story", () => {
  it("a headline that appears as a briefing and as a signal rotates once; the higher-ranked copy stays", async () => {
    const { buildBannerItems } = await import("@/lib/news-banner");
    const now = new Date("2026-11-07T12:00:00Z");
    const briefing = { id: "b1", topic: "fuel", title: "Diesel jumps 12 cents", headline: "Diesel up", created_at: "2026-11-07T10:00:00Z", read_at: null, delivery_class: "urgent" };
    const dupSignal = { id: "s1", topic: "fuel", summary: "Diesel jumps 12 cents!", observed_at: "2026-11-07T11:00:00Z", magnitude: 0.9, items: [] };
    const other = { id: "s2", topic: "rules", summary: "New ELD rule proposed", observed_at: "2026-11-07T11:00:00Z", magnitude: 0.8, items: [] };
    const items = buildBannerItems({ data: [briefing], signals: [dupSignal, other] } as never, now);
    expect(items.map((i) => i.id)).toEqual(["b1", "s2"]);
  });
});

describe("signal story presentation (conformance fix D2)", () => {
  it("a cluster signal headlines its first real story; the aggregate count becomes the sub", () => {
    const item = buildBannerItems(
      {
        data: [],
        signals: [
          signal({
            id: "sig-cluster",
            topic: "technology",
            summary: '19 technology news items on "ai chips" inside 48h (GDELT)',
            items: [
              { title: "Chip makers rally on new orders", url: "https://example.com/a", publishedAt: "2026-11-02T00:00:00Z", summary: "example.com", imageUrl: "https://img.example.com/a.jpg" },
              { title: "Second story", url: "https://example.com/b", publishedAt: "2026-11-02T00:00:00Z", summary: "example.com" },
            ],
          }),
        ],
      },
      NOW,
    )[0]!;
    expect(item.headline).toBe("Chip makers rally on new orders");
    expect(item.sub).toContain("19 technology news items");
    expect(item.imageSrc).toBe("/api/v1/news-image?signal=sig-cluster&i=0");
  });

  it("a single-source signal keeps its own summary as the headline", () => {
    const item = buildBannerItems(
      { data: [], signals: [signal({ id: "sig-fuel", summary: "Diesel $3.89 national average" })] },
      NOW,
    )[0]!;
    expect(item.headline).toBe("Diesel $3.89 national average");
    expect(item.sub).toBeNull();
  });
});
