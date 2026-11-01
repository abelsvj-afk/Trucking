// Deep Research Engine watcher: EIA weekly retail diesel
// (docs/design/research-engine.md §2). Reuses Stage 4's EIA integration
// (services/integrations/eia.ts), extended to return the last two
// weekly points so the week-over-week move - the number the trigger
// threshold reads - is computed from real data, never estimated.
//
// Key posture: EIA's API is free but keyed. With EIA_API_KEY set, this
// watcher emits one observation signal per new weekly period. Without
// it, the watcher SKIPS GRACEFULLY - status 'skipped' with the reason
// recorded in watcher state and shown on the Research page (the free
// key registration is an owner setup item, design §8). It never
// fabricates a price to fill the gap.

import { fetchFuelMarketHistory, type FuelMarketPoint } from "@/services/integrations/eia";
import type { PressureSignal, Watcher, WatcherResult } from "./types";

export const EIA_DIESEL_WATCHER_KEY = "eia_diesel";

/** Week-over-week percent change, signed. Null when it can't be computed honestly. */
export function weekOverWeekPct(points: FuelMarketPoint[]): number | null {
  const [latest, previous] = points;
  if (!latest || !previous || previous.pricePerGallon <= 0) return null;
  return ((latest.pricePerGallon - previous.pricePerGallon) / previous.pricePerGallon) * 100;
}

/** Builds the observation signal for a fresh EIA week. Pure - unit-tested without network. */
export function buildDieselSignal(points: FuelMarketPoint[], observedAt: string): PressureSignal | null {
  const [latest] = points;
  if (!latest) return null;
  const pct = weekOverWeekPct(points);
  const direction = pct === null ? "no prior week to compare yet" : pct >= 0 ? "up" : "down";
  const summary =
    pct === null
      ? `U.S. average diesel retail price (${latest.period}): $${latest.pricePerGallon.toFixed(3)}/gal - first observation, ${direction}.`
      : `U.S. average diesel retail price (${latest.period}): $${latest.pricePerGallon.toFixed(3)}/gal, ${direction} ${Math.abs(pct).toFixed(2)}% week over week.`;
  return {
    watcherKey: EIA_DIESEL_WATCHER_KEY,
    kind: "fuel_price_observation",
    topic: "fuel",
    // Pressure scales with the size of the move; the trigger threshold
    // (config.dieselThresholdPct) is the actual gate - magnitude is a
    // 0..1 summary of the same number (10%+ move saturates it).
    magnitude: pct === null ? 0.1 : Math.min(1, Math.abs(pct) / 10),
    summary,
    items: [
      {
        title: `EIA weekly diesel retail price - ${latest.period}`,
        url: "https://www.eia.gov/petroleum/gasdiesel/",
        publishedAt: latest.period,
        summary: `$${latest.pricePerGallon.toFixed(3)} per gallon (U.S. average, all types)`,
      },
    ],
    data: { wowPct: pct, pricePerGallon: latest.pricePerGallon, period: latest.period },
    dedupeKey: `eia_diesel:${latest.period}`,
    observedAt,
  };
}

export const eiaDieselWatcher: Watcher = {
  key: EIA_DIESEL_WATCHER_KEY,
  async poll(state: Record<string, unknown>): Promise<WatcherResult> {
    if (!process.env.EIA_API_KEY) {
      return {
        watcherKey: EIA_DIESEL_WATCHER_KEY,
        status: "skipped",
        message:
          "EIA_API_KEY is not set - diesel pressure is inferred from news only. Free key registration at eia.gov (owner setup item).",
        signals: [],
        state: {},
      };
    }

    try {
      const points = await fetchFuelMarketHistory(2);
      const [latest] = points;
      if (!latest) throw new Error("EIA returned no diesel data points.");
      if (state.lastPeriod === latest.period) {
        // Same week already recorded - no new signal, no re-trigger.
        return { watcherKey: EIA_DIESEL_WATCHER_KEY, status: "ok", message: null, signals: [], state: {} };
      }
      const signal = buildDieselSignal(points, new Date().toISOString());
      return {
        watcherKey: EIA_DIESEL_WATCHER_KEY,
        status: "ok",
        message: null,
        signals: signal ? [signal] : [],
        state: { lastPeriod: latest.period, lastPrice: latest.pricePerGallon },
      };
    } catch (err) {
      return {
        watcherKey: EIA_DIESEL_WATCHER_KEY,
        status: "error",
        message: err instanceof Error ? err.message : "Unknown error polling EIA.",
        signals: [],
        state: {},
      };
    }
  },
};
