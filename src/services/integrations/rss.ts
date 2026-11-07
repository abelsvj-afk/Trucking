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
  // The FMCSA newsroom's taxonomy feed (King's fix, 2026-11-05; the old /rss.xml did not answer from production).
  { source: "FMCSA Newsroom", url: "https://www.fmcsa.dot.gov/taxonomy/term/191/feed" },
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

/**
 * Honest, identifying request headers. rss-parser's own parseURL sent a bare
 * default client; several publisher sites (the FMCSA newsroom among them)
 * refuse or drop requests with no meaningful User-Agent / Accept, and the
 * failure came back as an opaque error. This names the app, asks for feed
 * content types, and - crucially - reports the HTTP status when refused so one
 * production poll tells us the real cause. It does NOT impersonate a browser
 * and uses no relay/proxy (owner ruling: those need a fresh decision).
 */
export const FEED_REQUEST_HEADERS = {
  "User-Agent": "TruckingResearchEngine/1.0 (owner-operator research bot; RSS reader)",
  Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
  "Accept-Language": "en-US,en;q=0.9",
} as const;

async function fetchOneFeed(feed: (typeof FEEDS)[number], fetchFn: typeof fetch): Promise<FeedFetchResult> {
  try {
    const res = await fetchFn(feed.url, {
      headers: FEED_REQUEST_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`${feed.source} answered HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
    }
    const parsed = await parser.parseString(await res.text());
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

export async function fetchIndustryNews(fetchFn: typeof fetch = fetch): Promise<FeedFetchResult[]> {
  return Promise.all(FEEDS.map((feed) => fetchOneFeed(feed, fetchFn)));
}

/** Any list of feeds, each fetched independently (one dead feed never sinks the others). Used by the news digest. */
export async function fetchFeedSet(feeds: { source: string; url: string }[], fetchFn: typeof fetch = fetch): Promise<FeedFetchResult[]> {
  return Promise.all(feeds.map((feed) => fetchOneFeed(feed, fetchFn)));
}
