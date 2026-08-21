// Task 4.1 (TASKS.md). Regulatory/industry-disruption source for the
// industry-intelligence engine (docs/design/ai-architecture.md) - a small
// set of public RSS feeds, free, no API key, no signup friction.
//
// VERIFICATION NOTE: this sandbox's network egress blocks outbound HTTPS
// to arbitrary external domains entirely (confirmed via curl against
// www.fmcsa.dot.gov: "CONNECT tunnel failed, response 403"), so these feed
// URLs and rss-parser's actual output shape against them are unverified
// from here. rss-parser itself is a well-established, widely-used library
// that tolerates real-world feed quirks (it's not hand-rolled XML
// parsing), and every item is treated as untrusted external content
// regardless (CLAUDE.md) - but confirm these specific feed URLs still
// resolve once this runs somewhere with real internet access.

import Parser from "rss-parser";

const FEEDS = [
  { source: "FMCSA Newsroom", url: "https://www.fmcsa.dot.gov/rss.xml" },
  { source: "FreightWaves", url: "https://www.freightwaves.com/news/feed" },
  { source: "Overdrive", url: "https://www.overdriveonline.com/feed" },
];

const parser = new Parser({ timeout: 15_000 });

export interface NewsItem {
  source: string;
  title: string;
  link: string;
  publishedAt: string | null;
  summary: string | null;
}

// One failed feed doesn't sink the others - each is fetched independently
// and a failure is recorded per-feed, not thrown, so a single dead RSS URL
// doesn't fail the whole industry-intelligence run over unrelated sources
// still being fine. The caller (services/ai's context assembly) decides
// what "enough sources" means for a given run's confidence.
export interface FeedFetchResult {
  source: string;
  items: NewsItem[];
  error: string | null;
}

async function fetchOneFeed(feed: (typeof FEEDS)[number]): Promise<FeedFetchResult> {
  try {
    const parsed = await parser.parseURL(feed.url);
    const items: NewsItem[] = (parsed.items ?? []).slice(0, 10).map((item) => ({
      source: feed.source,
      title: item.title ?? "(untitled)",
      link: item.link ?? feed.url,
      publishedAt: item.isoDate ?? item.pubDate ?? null,
      summary: item.contentSnippet ?? item.content ?? null,
    }));
    return { source: feed.source, items, error: null };
  } catch (err) {
    return {
      source: feed.source,
      items: [],
      error: err instanceof Error ? err.message : "Unknown error fetching feed.",
    };
  }
}

export async function fetchIndustryNews(): Promise<FeedFetchResult[]> {
  return Promise.all(FEEDS.map(fetchOneFeed));
}
