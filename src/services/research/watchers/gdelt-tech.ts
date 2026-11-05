// Deep Research Engine watcher: technology & automation
// (owner scope addition, 2026-11-02). GDELT articles on the tech
// shifts that change freight - autonomous trucking, AI dispatch and
// logistics automation, warehouse robotics, and major general-AI
// moves with freight relevance - clustered by subtheme into bursts
// on the tracked "technology" topic, shaped exactly like the GDELT
// geopolitics bursts so the trigger/convergence machinery needs no
// special cases.
//
// Scored as a WEAK source (0.6 in scoring.ts): vendor noise
// corroborates, it never leads. Two honesty rails on top of the geo
// pattern:
// - A burst's magnitude counts deployment/regulatory evidence
//   double - real trucks hauling real freight (or a regulator acting)
//   is pressure; a vendor announcing a product is not.
// - The solo hard-fire line in triggers.ts additionally REQUIRES
//   deployment evidence (config.techHardMinDeployment), so no pile
//   of press releases, however large, fires a run on its own.

import { fetchGdeltArticles, type GdeltArticle } from "@/services/integrations/gdelt";
import { getResearchConfig } from "../config";
import type { PressureSignal, Watcher, WatcherResult } from "./types";

export const GDELT_TECH_WATCHER_KEY = "gdelt_tech";

export const TECH_SUBTHEMES = ["autonomous_trucking", "ai_logistics", "warehouse_robotics", "general_ai"] as const;
export type TechSubtheme = (typeof TECH_SUBTHEMES)[number];

const SUBTHEME_LABELS: Record<TechSubtheme, string> = {
  autonomous_trucking: "autonomous trucking",
  ai_logistics: "AI dispatch / logistics automation",
  warehouse_robotics: "warehouse robotics",
  general_ai: "general AI with freight relevance",
};

/** One keyless GDELT query set per subtheme - the watcher's only sources. */
export const TECH_QUERY_SETS: { subtheme: TechSubtheme; query: string }[] = [
  {
    subtheme: "autonomous_trucking",
    query:
      '("autonomous truck" OR "autonomous trucking" OR "self-driving truck" OR "driverless truck" OR "driverless trucking")',
  },
  {
    subtheme: "ai_logistics",
    query:
      '("AI dispatch" OR "automated dispatching" OR "AI freight" OR "generative AI" logistics OR "artificial intelligence" "load board")',
  },
  {
    subtheme: "warehouse_robotics",
    query:
      '("warehouse robotics" OR "warehouse automation" OR "autonomous mobile robots" OR "goods-to-person" OR "robotic fulfillment")',
  },
  {
    subtheme: "general_ai",
    query: '("artificial intelligence" OR "generative AI" OR "AI model") (freight OR trucking OR logistics OR "supply chain")',
  },
];

const AUTONOMOUS_TERMS = [
  "autonomous truck",
  "autonomous trucking",
  "autonomous semi",
  "self-driving truck",
  "self-driving semi",
  "driverless truck",
  "driverless trucking",
  "driverless",
];
const AI_TERMS = [
  "artificial intelligence",
  "generative ai",
  "ai model",
  "ai agent",
  "ai agents",
  "large language model",
  "machine learning",
  " ai ",
  "ai-powered",
  "ai platform",
];
const LOGISTICS_TERMS = ["dispatch", "freight", "load board", "logistics", "trucking", "fleet", "supply chain", "carrier"];
const ROBOTICS_TERMS = [
  "warehouse robot",
  "warehouse robotics",
  "warehouse automation",
  "autonomous mobile robot",
  "goods-to-person",
  "robotic fulfillment",
  "robotics",
];

/**
 * Title phrases that mark real-world deployment or regulatory action -
 * the evidence class that weighs more than announcements. Matched on
 * titles only, like every other watcher read (thresholds never parse
 * briefing prose, but a headline IS the source data here).
 */
export const DEPLOYMENT_TERMS = [
  "driverless operations",
  "without a safety driver",
  "without safety driver",
  "no safety driver",
  "safety driver removed",
  "removes the safety driver",
  "commercial operations",
  "commercial service",
  "begins hauling",
  "began hauling",
  "hauling freight",
  "paid loads",
  "deployed",
  "deployment",
  "in service",
  "fmcsa",
  "exemption",
  "waiver",
  "permit",
  "regulator",
  "approved to operate",
];

function hasAny(hay: string, terms: string[]): boolean {
  return terms.some((term) => hay.includes(term));
}

/** Every subtheme a headline belongs to (an article can sit in several clusters, like tracked topics). Pure. */
export function classifyTechSubthemes(title: string): TechSubtheme[] {
  const hay = ` ${title.toLowerCase()} `;
  const out: TechSubtheme[] = [];
  if (hasAny(hay, AUTONOMOUS_TERMS)) out.push("autonomous_trucking");
  if (hasAny(hay, ROBOTICS_TERMS)) out.push("warehouse_robotics");
  if (hasAny(hay, AI_TERMS)) {
    if (hasAny(hay, LOGISTICS_TERMS)) out.push("ai_logistics");
    out.push("general_ai");
  }
  return out;
}

/** True when a headline carries deployment/regulatory evidence rather than announcement language. Pure. */
export function hasDeploymentEvidence(title: string): boolean {
  return hasAny(` ${title.toLowerCase()} `, DEPLOYMENT_TERMS);
}

/** Builds one burst signal per subtheme cluster at/above the burst floor. Pure - unit-tested. */
export function buildTechSignals(
  articles: GdeltArticle[],
  config: { newsBurstMinItems: number },
  observedAt: string,
): PressureSignal[] {
  const bySubtheme = new Map<TechSubtheme, GdeltArticle[]>();
  for (const article of articles) {
    for (const subtheme of classifyTechSubthemes(article.title)) {
      const list = bySubtheme.get(subtheme) ?? [];
      list.push(article);
      bySubtheme.set(subtheme, list);
    }
  }
  const day = observedAt.slice(0, 10);
  const signals: PressureSignal[] = [];
  for (const subtheme of TECH_SUBTHEMES) {
    const cluster = bySubtheme.get(subtheme);
    if (!cluster || cluster.length < config.newsBurstMinItems) continue;
    const deploymentCount = cluster.filter((a) => hasDeploymentEvidence(a.title)).length;
    signals.push({
      watcherKey: GDELT_TECH_WATCHER_KEY,
      kind: "tech_burst",
      topic: "technology",
      // Same base curve as the geo bursts, with deployment evidence
      // counting double - a cluster of real deployments outweighs a
      // same-size cluster of announcements.
      magnitude: Math.min(1, 0.4 + (cluster.length + deploymentCount) / 40),
      summary:
        `${cluster.length} technology news items on "${SUBTHEME_LABELS[subtheme]}" inside 48h (GDELT)` +
        (deploymentCount > 0
          ? ` - ${deploymentCount} report real-world deployment or regulatory action.`
          : " - announcements and coverage only, no deployment or regulatory action reported."),
      items: cluster.slice(0, 10).map((a) => ({
        title: a.title,
        url: a.url,
        publishedAt: a.seenDate,
        summary: a.domain,
        ...(a.imageUrl ? { imageUrl: a.imageUrl } : {}),
      })),
      data: { itemCount: cluster.length, deploymentCount, subtheme },
      dedupeKey: `tech_burst:${subtheme}:${day}`,
      observedAt,
    });
  }
  return signals;
}

export const gdeltTechWatcher: Watcher = {
  key: GDELT_TECH_WATCHER_KEY,
  async poll(): Promise<WatcherResult> {
    const config = getResearchConfig();
    const articles: GdeltArticle[] = [];
    const seenUrls = new Set<string>();
    const failures: string[] = [];
    for (const set of TECH_QUERY_SETS) {
      try {
        const batch = await fetchGdeltArticles("48h", 75, fetch, set.query);
        for (const article of batch) {
          // The same story can surface under two query sets; it is
          // one piece of pressure, never two.
          if (seenUrls.has(article.url)) continue;
          seenUrls.add(article.url);
          articles.push(article);
        }
      } catch (err) {
        failures.push(`${set.subtheme}: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }
    if (failures.length === TECH_QUERY_SETS.length) {
      return {
        watcherKey: GDELT_TECH_WATCHER_KEY,
        status: "error",
        message: `All GDELT tech query sets failed: ${failures.join("; ")}`,
        signals: [],
        state: {},
      };
    }
    const signals = buildTechSignals(articles, config, new Date().toISOString());
    return {
      watcherKey: GDELT_TECH_WATCHER_KEY,
      status: "ok",
      message: failures.length > 0 ? `Partial coverage: ${failures.join("; ")}` : null,
      signals,
      state: { lastArticleCount: articles.length },
    };
  },
};
