// Smart Path intelligence, Phase 3: the road-work section of a route check. For each
// crossed state with a registered feed, fetch (cached 5 min), parse, and keep events
// near the route and active at his arrival. A state with no feed, a feed that is down
// or malformed: named in `notes` - never reported as clear. Never throws.

import { parseWzdx } from "@/lib/smart-path-roadwork";
import { roadWorkItems, type RoadWorkItem } from "@/lib/smart-path-roadwork";
import { WZDX_FEEDS, type WzdxFeed } from "@/services/integrations/wzdx-feeds";

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; json: unknown }>();

export type FeedFetcher = (url: string) => Promise<unknown>;

export const defaultFeedFetcher: FeedFetcher = async (url) => {
  if (!url.startsWith("https://")) throw new Error("Feed URL must be https.");
  const res = await fetch(url, {
    headers: { "User-Agent": "TruckingRouteCheck/1.0 (owner-operator route planning)", Accept: "application/geo+json, application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`answered HTTP ${res.status}`);
  return res.json();
};

export interface RoadWorkSection {
  status: "ok" | "partial" | "unavailable";
  items: RoadWorkItem[];
  notes: string[];
  asOf: string;
}

export async function buildRoadWorkSection(
  statesCrossed: string[],
  corridor: { mile: number; lat: number; lng: number; etaAt: string | null }[],
  truckHeightIn: number | null,
  opts: { feeds?: WzdxFeed[]; fetcher?: FeedFetcher; now?: Date } = {},
): Promise<RoadWorkSection> {
  const feeds = opts.feeds ?? WZDX_FEEDS;
  const fetcher = opts.fetcher ?? defaultFeedFetcher;
  const now = opts.now ?? new Date();
  const useCache = !opts.fetcher;
  const notes: string[] = [];
  const items: RoadWorkItem[] = [];
  let covered = 0;
  let failed = 0;

  for (const state of [...new Set(statesCrossed)]) {
    const feed = feeds.find((f) => f.state === state);
    if (!feed) {
      notes.push(`No work-zone data for ${state} - that does not mean there is no road work there.`);
      continue;
    }
    try {
      const hit = useCache ? cache.get(feed.url) : undefined;
      const json = hit && now.getTime() - hit.at < TTL_MS ? hit.json : await fetcher(feed.url);
      if (useCache && !hit) cache.set(feed.url, { at: now.getTime(), json });
      const { events, skipped } = parseWzdx(json);
      items.push(...roadWorkItems(events, corridor, truckHeightIn));
      covered += 1;
      if (skipped > 0) notes.push(`${state}: ${skipped} work-zone record${skipped === 1 ? "" : "s"} couldn't be read and were left out.`);
    } catch (err) {
      failed += 1;
      notes.push(`${state} work-zone feed unavailable (${err instanceof Error ? err.message : "error"}) - road work there is unknown.`);
    }
  }
  const status = covered === 0 ? "unavailable" : failed > 0 || notes.length > 0 ? "partial" : "ok";
  return { status, items: items.sort((a, b) => a.mile - b.mile), notes, asOf: now.toISOString() };
}
