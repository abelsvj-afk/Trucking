import { describe, expect, it, vi } from "vitest";

// NO rss-parser mock in this file on purpose: the FMCSA swap audit warned that
// changing a URL without verifying the feed SHAPE parses is not enough. These
// tests run the real rss-parser (the same pipeline every other source uses)
// against a representative Google News RSS sample.

import { fetchFeedSet, fetchIndustryNews } from "@/services/integrations/rss";
import { NEWS_FEEDS } from "@/services/integrations/news-feeds";
import { buildFederalRegisterUrl, FEDERAL_REGISTER_WATCHER_KEY } from "@/services/research/watchers/federal-register";

const GOOGLE_NEWS_FMCSA_URL =
  "https://news.google.com/rss/search?q=FMCSA%20trucking%20regulation&hl=en-US&gl=US&ceid=US:en";

// Representative Google News search RSS: standard RSS 2.0 channel whose items
// carry the shape Google News actually emits - a "Headline - Publisher" title,
// a news.google.com redirect link, an RFC-822 pubDate, an HTML description and
// a <source> element naming the publisher.
const GOOGLE_NEWS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>FMCSA trucking regulation - Google News</title>
    <link>https://news.google.com/search?q=FMCSA+trucking+regulation</link>
    <description>Google News search results for FMCSA trucking regulation.</description>
    <item>
      <title>FMCSA proposes new speed limiter rule for heavy trucks - FreightWaves</title>
      <link>https://news.google.com/rss/articles/CBMiExampleRedirectToken1?oc=5</link>
      <pubDate>Fri, 07 Nov 2026 14:30:00 GMT</pubDate>
      <description>&lt;a href="https://news.google.com/rss/articles/CBMiExampleRedirectToken1"&gt;FMCSA proposes new speed limiter rule for heavy trucks&lt;/a&gt; FreightWaves</description>
      <guid isPermaLink="false">CBMiExampleRedirectToken1</guid>
      <source url="https://www.freightwaves.com">FreightWaves</source>
    </item>
    <item>
      <title>Drug and Alcohol Clearinghouse updates take effect - Transport Topics</title>
      <link>https://news.google.com/rss/articles/CBMiExampleRedirectToken2?oc=5</link>
      <pubDate>Thu, 06 Nov 2026 09:15:00 GMT</pubDate>
      <description>&lt;a href="https://news.google.com/rss/articles/CBMiExampleRedirectToken2"&gt;Drug and Alcohol Clearinghouse updates take effect&lt;/a&gt; Transport Topics</description>
      <guid isPermaLink="false">CBMiExampleRedirectToken2</guid>
      <source url="https://www.ttnews.com">Transport Topics</source>
    </item>
  </channel>
</rss>`;

const MINIMAL_RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>`;

describe("Google News feed shape through the real RSS pipeline", () => {
  it("parses a representative Google News RSS sample into normalized items", async () => {
    const fetchFn = vi.fn(async () => new Response(GOOGLE_NEWS_SAMPLE, { status: 200 }));
    const [result] = await fetchFeedSet([{ source: "Google News", url: GOOGLE_NEWS_FMCSA_URL }], fetchFn as never);

    expect(result!.error).toBeNull();
    expect(result!.source).toBe("Google News");
    expect(result!.items).toHaveLength(2);
    expect(result!.items[0]).toMatchObject({
      source: "Google News",
      title: "FMCSA proposes new speed limiter rule for heavy trucks - FreightWaves",
      link: "https://news.google.com/rss/articles/CBMiExampleRedirectToken1?oc=5",
    });
    // pubDate (RFC-822, the format Google News emits) lands as an ISO publishedAt.
    expect(result!.items[0]!.publishedAt).toBe(new Date("Fri, 07 Nov 2026 14:30:00 GMT").toISOString());
    expect(result!.items[1]!.title).toContain("Clearinghouse");
    expect(result!.items[1]!.publishedAt).toBe(new Date("Thu, 06 Nov 2026 09:15:00 GMT").toISOString());
  });
});

describe("the FMCSA swap is the truth in BOTH registries (owner ruling 2026-11-06)", () => {
  it("rss.ts industry feeds: Google News in, no FMCSA Newsroom URL in any form", async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(MINIMAL_RSS, { status: 200 }));
    await fetchIndustryNews(fetchFn as never);
    const urls = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain(GOOGLE_NEWS_FMCSA_URL);
    expect(urls.some((u) => u.includes("fmcsa.dot.gov"))).toBe(false);
    expect(urls.some((u) => u.toLowerCase().includes("newsroom"))).toBe(false);
  });

  it("news-feeds.ts: regulation topic is Google News, and no topic carries the Newsroom feed", () => {
    expect(NEWS_FEEDS.regulation).toEqual([{ source: "Google News", url: GOOGLE_NEWS_FMCSA_URL }]);
    const everyFeed = Object.values(NEWS_FEEDS).flat();
    expect(everyFeed.some((f) => f.url.includes("fmcsa.dot.gov"))).toBe(false);
    expect(everyFeed.some((f) => f.source === "FMCSA Newsroom")).toBe(false);
  });

  it("the Federal Register source is still present and untouched (official rules coverage)", () => {
    expect(FEDERAL_REGISTER_WATCHER_KEY).toBe("federal_register");
    const url = buildFederalRegisterUrl();
    expect(url.origin + url.pathname).toBe("https://www.federalregister.gov/api/v1/documents.json");
    expect(url.search).toContain("federal-motor-carrier-safety-administration");
  });
});
