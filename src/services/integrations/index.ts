// Task 4.1 (TASKS.md). Combines the two top-level sources
// docs/design/ai-architecture.md's worked example names into one call for
// services/ai to consume. "Unreachable" (docs/automation.md's Failure
// recovery, as clarified there) means EIA failing outright, or every RSS
// feed failing - not one feed among several. Everything returned here is
// untrusted external content (CLAUDE.md), never treated as instructions.

import { fetchFuelMarketSnapshot, type FuelMarketSnapshot } from "./eia";
import { fetchIndustryNews, type FeedFetchResult } from "./rss";

export type { FuelMarketSnapshot } from "./eia";
export type { NewsItem, FeedFetchResult } from "./rss";

export class SourceUnreachableError extends Error {}

export interface IndustrySources {
  fuelMarket: FuelMarketSnapshot;
  news: FeedFetchResult[];
  /** True when one or more (but not all) RSS feeds failed - "thin" data per docs/design/ai-architecture.md, not a hard failure. */
  newsPartial: boolean;
}

export async function gatherIndustrySources(): Promise<IndustrySources> {
  const [fuelMarket, news] = await Promise.all([
    fetchFuelMarketSnapshot().catch((err: unknown) => {
      throw new SourceUnreachableError(
        `Fuel-market source (EIA) unreachable: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }),
    fetchIndustryNews(),
  ]);

  const failedFeeds = news.filter((feed) => feed.error !== null);
  if (failedFeeds.length === news.length) {
    throw new SourceUnreachableError(
      `News source unreachable: all ${news.length} feeds failed (${failedFeeds
        .map((f) => `${f.source}: ${f.error}`)
        .join("; ")}).`,
    );
  }

  return { fuelMarket, news, newsPartial: failedFeeds.length > 0 };
}
