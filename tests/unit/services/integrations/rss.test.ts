import { describe, expect, it, vi } from "vitest";

const { parseStringMock } = vi.hoisted(() => ({ parseStringMock: vi.fn() }));

vi.mock("rss-parser", () => ({
  default: class {
    parseString = parseStringMock;
  },
}));

import { FEED_REQUEST_HEADERS, fetchIndustryNews } from "@/services/integrations/rss";

const okFetch = () => vi.fn(async (_url: string, _init?: RequestInit) => new Response("<rss/>", { status: 200 }));

describe("fetchIndustryNews", () => {
  it("normalizes items from every feed that succeeds", async () => {
    parseStringMock.mockResolvedValue({
      items: [
        {
          title: "New FMCSA rule proposed",
          link: "https://example.test/1",
          isoDate: "2026-08-20T00:00:00Z",
          contentSnippet: "Summary of the rule.",
        },
      ],
    });

    const results = await fetchIndustryNews(okFetch() as never);

    expect(results).toHaveLength(3);
    for (const feed of results) {
      expect(feed.error).toBeNull();
      expect(feed.items[0]).toEqual({
        source: feed.source,
        title: "New FMCSA rule proposed",
        link: "https://example.test/1",
        publishedAt: "2026-08-20T00:00:00Z",
        summary: "Summary of the rule.",
      });
    }
  });

  it("records a per-feed error instead of throwing, so one dead feed doesn't sink the others", async () => {
    const results = await fetchIndustryNews(vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as never);

    expect(results).toHaveLength(3);
    for (const feed of results) {
      expect(feed.error).toBe("ECONNREFUSED");
      expect(feed.items).toEqual([]);
    }
  });

  it("caps items at 10 per feed", async () => {
    parseStringMock.mockResolvedValue({
      items: Array.from({ length: 25 }, (_, i) => ({ title: `Item ${i}`, link: `https://example.test/${i}` })),
    });

    const results = await fetchIndustryNews(okFetch() as never);
    expect(results[0]?.items).toHaveLength(10);
  });

  it("sends identifying headers (no browser impersonation) and a timeout signal", async () => {
    parseStringMock.mockResolvedValue({ items: [] });
    const fetchFn = okFetch();
    await fetchIndustryNews(fetchFn as never);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    const init = fetchFn.mock.calls[0]![1]!;
    expect(init.headers).toEqual(FEED_REQUEST_HEADERS);
    expect(String((init.headers as Record<string, string>)["User-Agent"])).toContain("TruckingResearchEngine");
    expect(String((init.headers as Record<string, string>)["User-Agent"])).not.toMatch(/Mozilla|Chrome|Safari/);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("a refusal names the HTTP status, so one production poll shows the real cause", async () => {
    const results = await fetchIndustryNews(vi.fn(async () => new Response("denied", { status: 403, statusText: "Forbidden" })) as never);
    expect(results[0]!.error).toMatch(/answered HTTP 403 Forbidden/);
    expect(results[0]!.error).toContain(results[0]!.source);
  });

  it("fetches FMCSA headlines from Google News and no longer polls the FMCSA Newsroom (HTTP 403 from production)", async () => {
    parseStringMock.mockResolvedValue({ items: [] });
    const fetchFn = okFetch();
    await fetchIndustryNews(fetchFn as never);
    const urls = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("https://news.google.com/rss/search?q=FMCSA&hl=en-US&gl=US&ceid=US:en");
    expect(urls.some((u) => u.includes("fmcsa.dot.gov"))).toBe(false);
  });
});

import { NEWS_FEEDS } from "@/services/integrations/news-feeds";
describe("no feed list still points at the FMCSA Newsroom", () => {
  it("the news digest feeds were swapped too, and the regulation topic is not left empty", () => {
    const all = Object.values(NEWS_FEEDS).flat();
    expect(all.some((f) => f.url.includes("fmcsa.dot.gov"))).toBe(false);
    expect(NEWS_FEEDS.regulation.length).toBeGreaterThan(0);
    expect(NEWS_FEEDS.regulation[0]!.url).toContain("news.google.com/rss/search?q=FMCSA");
  });
});
