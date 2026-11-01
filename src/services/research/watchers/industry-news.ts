// Deep Research Engine watcher: industry news bursts
// (docs/design/research-engine.md §2). Reuses Stage 4's RSS layer
// (FMCSA Newsroom, FreightWaves, Overdrive - free, no key) and turns
// raw items into pressure only when a tracked topic CLUSTER heats up:
// >= config.newsBurstMinItems items inside the window matching the
// same topic. One loud headline is noise; a cluster is pressure.
//
// Per-feed failures follow the RSS layer's own contract (recorded per
// feed, never thrown). If EVERY feed fails, the watcher reports
// 'error' - a dead news layer must be visible, not mistaken for a
// quiet news cycle.

import { fetchIndustryNews, type NewsItem } from "@/services/integrations/rss";
import { getResearchConfig } from "../config";
import { matchTrackedTopics, TRACKED_TOPICS, type PressureSignal, type TrackedTopic, type Watcher, type WatcherResult } from "./types";

export const INDUSTRY_NEWS_WATCHER_KEY = "industry_news";

export interface TopicCluster {
  topic: TrackedTopic;
  items: NewsItem[];
}

/** Groups items by every tracked topic they match. Pure - unit-tested on fixtures. */
export function clusterNewsItems(items: NewsItem[]): TopicCluster[] {
  const byTopic = new Map<TrackedTopic, NewsItem[]>();
  for (const item of items) {
    for (const topic of matchTrackedTopics(`${item.title} ${item.summary ?? ""}`)) {
      const list = byTopic.get(topic) ?? [];
      list.push(item);
      byTopic.set(topic, list);
    }
  }
  return TRACKED_TOPICS.filter((topic) => byTopic.has(topic)).map((topic) => ({
    topic,
    items: byTopic.get(topic) as NewsItem[],
  }));
}

/** Builds a burst signal for one cluster, or null when it's below the burst floor. */
export function buildBurstSignal(
  cluster: TopicCluster,
  config: { newsBurstMinItems: number },
  observedAt: string,
): PressureSignal | null {
  if (cluster.items.length < config.newsBurstMinItems) return null;
  const day = observedAt.slice(0, 10);
  return {
    watcherKey: INDUSTRY_NEWS_WATCHER_KEY,
    kind: "news_burst",
    topic: cluster.topic,
    // Scales with cluster size: floor burst = 0.5, saturates at 2x the floor.
    magnitude: Math.min(1, 0.5 + (cluster.items.length - config.newsBurstMinItems) / (config.newsBurstMinItems * 2)),
    summary: `${cluster.items.length} industry news items on "${cluster.topic}" inside the burst window - the topic is heating up across feeds.`,
    items: cluster.items.map((item) => ({
      title: item.title,
      url: item.link,
      publishedAt: item.publishedAt,
      summary: item.summary,
    })),
    data: { itemCount: cluster.items.length },
    dedupeKey: `news_burst:${cluster.topic}:${day}`,
    observedAt,
  };
}

export const industryNewsWatcher: Watcher = {
  key: INDUSTRY_NEWS_WATCHER_KEY,
  async poll(): Promise<WatcherResult> {
    const config = getResearchConfig();
    const feeds = await fetchIndustryNews();
    const failed = feeds.filter((feed) => feed.error !== null);
    if (failed.length === feeds.length) {
      return {
        watcherKey: INDUSTRY_NEWS_WATCHER_KEY,
        status: "error",
        message: `All news feeds failed: ${failed.map((f) => `${f.source}: ${f.error}`).join("; ")}`,
        signals: [],
        state: {},
      };
    }

    const windowStart = Date.now() - config.newsBurstWindowHours * 60 * 60 * 1000;
    const recent = feeds
      .flatMap((feed) => feed.items)
      .filter((item) => {
        if (!item.publishedAt) return true; // undated items can't be aged out honestly
        const when = Date.parse(item.publishedAt);
        return Number.isNaN(when) || when >= windowStart;
      });

    const observedAt = new Date().toISOString();
    const signals = clusterNewsItems(recent)
      .map((cluster) => buildBurstSignal(cluster, config, observedAt))
      .filter((signal): signal is PressureSignal => signal !== null);

    return {
      watcherKey: INDUSTRY_NEWS_WATCHER_KEY,
      status: "ok",
      message:
        failed.length > 0
          ? `Partial coverage: ${failed.map((f) => f.source).join(", ")} failed this poll.`
          : null,
      signals,
      state: { lastItemCount: recent.length },
    };
  },
};
