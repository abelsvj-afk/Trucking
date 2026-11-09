// Deep Research Engine convergence scoring (2026-11-02 design, D-4).
// Pure functions, unit-tested without a database: every signal gets a
// pressure score, and a topic fires either on one hard signal (the
// pre-upgrade behavior, preserved in triggers.ts) or when DISTINCT
// sources converge on the same topic inside the window. One loud
// headline never fires a run on convergence; three quiet stories from
// three different sources do.

import type { ResearchConfig } from "./config";
import type { PressureSignal } from "./watchers/types";

/**
 * How much a source's word counts. Official data and rulemaking are
 * ground truth (1.0); market data is real but noisy (0.8); news-shaped
 * sources are the weakest (0.6) - they corroborate, they don't lead.
 */
export const SOURCE_WEIGHTS: Record<string, number> = {
  eia_diesel: 1.0,
  eia_diesel_regional: 1.0,
  federal_register: 1.0,
  nws_weather: 1.0,
  openstates: 0.9,
  stooq_market: 0.8,
  fred_market: 0.8,
  coingecko_crypto: 0.8,
  gdelt_geo: 0.6,
  gdelt_tech: 0.6,
  industry_news: 0.6,
};

export function sourceWeight(watcherKey: string): number {
  return SOURCE_WEIGHTS[watcherKey] ?? 0.5;
}

/** Linear decay: full weight now, a quarter left at the window edge, nothing after. */
export function recencyDecay(observedAt: string, now: Date, windowHours: number): number {
  const ageHours = (now.getTime() - Date.parse(observedAt)) / (60 * 60 * 1000);
  if (!Number.isFinite(ageHours) || ageHours < 0) return 1;
  if (ageHours >= windowHours) return 0;
  return 1 - 0.75 * (ageHours / windowHours);
}

/** One signal's pressure score right now. */
export function scoreSignal(signal: PressureSignal, now: Date, config: ResearchConfig): number {
  return signal.magnitude * sourceWeight(signal.watcherKey) * recencyDecay(signal.observedAt, now, config.convergenceWindowHours);
}

/**
 * The convergence score for one topic: group signals by source
 * (watcher), keep only the strongest score per source, sum across
 * sources. Distinct-source corroboration is the entire point - five
 * stories from one feed count once.
 */
export function topicConvergenceScore(
  signals: PressureSignal[],
  topic: string,
  now: Date,
  config: ResearchConfig,
): number {
  const bestBySource = new Map<string, number>();
  for (const signal of signals) {
    if (signal.topic !== topic) continue;
    const score = scoreSignal(signal, now, config);
    if (score <= 0) continue;
    const current = bestBySource.get(signal.watcherKey) ?? 0;
    if (score > current) bestBySource.set(signal.watcherKey, score);
  }
  let total = 0;
  for (const score of bestBySource.values()) total += score;
  return total;
}

/**
 * Market-snapshot pseudo-pressure (D-3): the market watcher emits one
 * daily observation that never hard-fires, but a big crude move IS
 * fuel pressure and a big Transports move IS rates pressure. Returns
 * synthetic signals (scored like real ones) for whichever side crossed
 * its market threshold, so the convergence layer can count them.
 */
export function marketPressureSignals(signal: PressureSignal, config: ResearchConfig): PressureSignal[] {
  // "fred_market" is the watcher since the 2026-11-03 Stooq -> FRED
  // switch; "stooq_market" signals already stored from before the
  // switch keep scoring until they age out of the window.
  if (signal.watcherKey !== "fred_market" && signal.watcherKey !== "stooq_market") return [];
  const out: PressureSignal[] = [];
  const crude = signal.data.crudeWowPct;
  if (typeof crude === "number" && Math.abs(crude) >= config.marketCrudeThresholdPct) {
    out.push({
      ...signal,
      topic: "fuel",
      kind: "market_pressure",
      magnitude: Math.min(1, Math.abs(crude) / 10),
      summary: `Crude oil moved ${crude >= 0 ? "up" : "down"} ${Math.abs(crude).toFixed(1)}% week over week - market pressure on fuel.`,
      dedupeKey: `${signal.dedupeKey}:fuel`,
    });
  }
  const transports = signal.data.transportsWowPct;
  if (typeof transports === "number" && Math.abs(transports) >= config.marketTransportsThresholdPct) {
    out.push({
      ...signal,
      topic: "rates",
      kind: "market_pressure",
      magnitude: Math.min(1, Math.abs(transports) / 8),
      summary: `Dow Transports moved ${transports >= 0 ? "up" : "down"} ${Math.abs(transports).toFixed(1)}% week over week - market pressure on freight rates.`,
      dedupeKey: `${signal.dedupeKey}:rates`,
    });
  }
  return out;
}
