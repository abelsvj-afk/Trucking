// The owner's news topics and the free public RSS feeds behind them (owner 2026-11-07: trucking, tech, political and
// general news; docs/design/fleet-learning-and-driver-questions.md section 4). Read through the existing RSS layer, so
// per-feed failures are reported, never thrown. NO KEYS, no paid service.
//
// VERIFICATION NOTE: like the industry feeds in rss.ts, these URLs could not be fetched from the build sandbox (its
// egress is blocked), so they are UNVERIFIED from here. A feed that does not answer is named in the digest, and the
// owner or King can edit this list. Political news deliberately draws on SEVERAL outlets across the spectrum and every
// headline carries its source - Abel shows what they published and does not editorialise.

import { fetchFeedSet, type FeedFetchResult } from "./rss";
import type { NewsTopic } from "@/lib/fleet/preferences";

export const NEWS_FEEDS: Record<NewsTopic, { source: string; url: string }[]> = {
  trucking: [
    { source: "FreightWaves", url: "https://www.freightwaves.com/news/feed" },
    { source: "Overdrive", url: "https://www.overdriveonline.com/feed" },
    { source: "CDLLife", url: "https://cdllife.com/feed/" },
    { source: "Land Line", url: "https://landline.media/feed/" },
  ],
  regulation: [
    // Google News headlines replace the FMCSA Newsroom feed (owner ruling 2026-11-06, no
    // coverage gap: the Federal Register watcher carries the official rules, proven live;
    // the Newsroom feed answered HTTP 403 from production). Same swap as rss.ts.
    { source: "Google News", url: "https://news.google.com/rss/search?q=FMCSA%20trucking%20regulation&hl=en-US&gl=US&ceid=US:en" },
  ],
  tech: [
    { source: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },
    { source: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
    { source: "NPR Technology", url: "https://feeds.npr.org/1019/rss.xml" },
    { source: "Hacker News", url: "https://hnrss.org/frontpage" },
  ],
  politics: [
    { source: "NPR Politics", url: "https://feeds.npr.org/1014/rss.xml" },
    { source: "BBC US & Canada", url: "https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml" },
    { source: "The Hill", url: "https://thehill.com/news/feed/" },
    { source: "Fox News Politics", url: "https://moxie.foxnews.com/google-publisher/politics.xml" },
  ],
  world: [
    { source: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
    { source: "NPR News", url: "https://feeds.npr.org/1001/rss.xml" },
  ],
};

export interface TopicFetch {
  topic: NewsTopic;
  results: FeedFetchResult[];
}

export async function fetchNewsTopics(topics: NewsTopic[], fetchFn: typeof fetch = fetch): Promise<TopicFetch[]> {
  return Promise.all(topics.map(async (topic) => ({ topic, results: await fetchFeedSet(NEWS_FEEDS[topic], fetchFn) })));
}
