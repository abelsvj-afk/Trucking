// Deep Research Engine watcher: geopolitical / overseas events
// (2026-11-02 design, D-3). GDELT articles on energy/shipping/supply
// themes, clustered by tracked topic exactly like the industry-news
// bursts - but scored as a WEAK source (0.6 in scoring.ts): overseas
// noise corroborates pressure, it takes a very large cluster
// (config.geoHardMinItems) to fire alone. Burst-shaped on purpose so
// the trigger/convergence machinery needs no special cases.

import { fetchGdeltArticles, type GdeltArticle } from "@/services/integrations/gdelt";
import { getResearchConfig } from "../config";
import { matchTrackedTopics, TRACKED_TOPICS, type PressureSignal, type TrackedTopic, type Watcher, type WatcherResult } from "./types";

export const GDELT_WATCHER_KEY = "gdelt_geo";

/** Builds one burst signal per topic cluster at/above the burst floor. Pure - unit-tested. */
export function buildGdeltSignals(
  articles: GdeltArticle[],
  config: { newsBurstMinItems: number },
  observedAt: string,
): PressureSignal[] {
  const byTopic = new Map<TrackedTopic, GdeltArticle[]>();
  for (const article of articles) {
    for (const topic of matchTrackedTopics(article.title)) {
      const list = byTopic.get(topic) ?? [];
      list.push(article);
      byTopic.set(topic, list);
    }
  }
  const day = observedAt.slice(0, 10);
  const signals: PressureSignal[] = [];
  for (const topic of TRACKED_TOPICS) {
    const cluster = byTopic.get(topic);
    if (!cluster || cluster.length < config.newsBurstMinItems) continue;
    signals.push({
      watcherKey: GDELT_WATCHER_KEY,
      kind: "geo_burst",
      topic,
      magnitude: Math.min(1, 0.4 + cluster.length / 40),
      summary: `${cluster.length} overseas/global news items on "${topic}" inside 48h (GDELT) - shipping/energy events are clustering.`,
      items: cluster.slice(0, 10).map((a) => ({
        title: a.title,
        url: a.url,
        publishedAt: a.seenDate,
        summary: a.domain,
      })),
      data: { itemCount: cluster.length },
      dedupeKey: `geo_burst:${topic}:${day}`,
      observedAt,
    });
  }
  return signals;
}

export const gdeltGeoWatcher: Watcher = {
  key: GDELT_WATCHER_KEY,
  async poll(): Promise<WatcherResult> {
    const config = getResearchConfig();
    try {
      const articles = await fetchGdeltArticles();
      const signals = buildGdeltSignals(articles, config, new Date().toISOString());
      return {
        watcherKey: GDELT_WATCHER_KEY,
        status: "ok",
        message: null,
        signals,
        state: { lastArticleCount: articles.length },
      };
    } catch (err) {
      return {
        watcherKey: GDELT_WATCHER_KEY,
        status: "error",
        message: err instanceof Error ? err.message : "Unknown error polling GDELT.",
        signals: [],
        state: {},
      };
    }
  },
};
