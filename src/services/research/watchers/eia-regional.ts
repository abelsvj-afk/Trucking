// Deep Research Engine watcher: EIA regional diesel (2026-11-02
// design, D-3). The national average hides the moves that matter to a
// Florida/Gulf driver; this watcher tracks the two PADD regions his
// lanes actually burn fuel in - PADD 1 (East Coast) and PADD 3 (Gulf
// Coast) - through the same free EIA key and the same skip-visibly
// posture as the national watcher. Regional signals carry the same
// data shape ({ wowPct }) so the trigger engine reads them with the
// national threshold, and corridor escalation (D-5) can weigh them.

import { fetchFuelMarketHistory, type FuelMarketPoint } from "@/services/integrations/eia";
import { buildDieselSignal } from "./eia-diesel";
import type { PressureSignal, Watcher, WatcherResult } from "./types";

export const EIA_REGIONAL_WATCHER_KEY = "eia_diesel_regional";

export const DIESEL_REGIONS = [
  { duoarea: "R10", label: "East Coast (PADD 1)" },
  { duoarea: "R30", label: "Gulf Coast (PADD 3)" },
] as const;

/** Builds one region's signal from its weekly points. Pure - unit-tested. */
export function buildRegionalDieselSignal(
  region: { duoarea: string; label: string },
  points: FuelMarketPoint[],
  observedAt: string,
): PressureSignal | null {
  const base = buildDieselSignal(points, observedAt);
  if (!base) return null;
  const [latest] = points;
  return {
    ...base,
    watcherKey: EIA_REGIONAL_WATCHER_KEY,
    summary: base.summary.replace("U.S. average diesel retail price", `${region.label} diesel retail price`),
    items: base.items.map((item) => ({ ...item, title: `EIA weekly diesel retail price (${region.label}) - ${latest?.period ?? ""}` })),
    data: { ...base.data, area: region.duoarea, areaLabel: region.label },
    dedupeKey: `eia_diesel_regional:${region.duoarea}:${latest?.period ?? "unknown"}`,
  };
}

export const eiaRegionalWatcher: Watcher = {
  key: EIA_REGIONAL_WATCHER_KEY,
  async poll(state: Record<string, unknown>): Promise<WatcherResult> {
    if (!process.env.EIA_API_KEY) {
      return {
        watcherKey: EIA_REGIONAL_WATCHER_KEY,
        status: "skipped",
        message: "EIA_API_KEY is not set - regional diesel pressure is unavailable (same free key as the national watcher).",
        signals: [],
        state: {},
      };
    }

    const signals: PressureSignal[] = [];
    const nextState: Record<string, unknown> = {};
    const failures: string[] = [];
    const observedAt = new Date().toISOString();

    for (const region of DIESEL_REGIONS) {
      const stateKey = `lastPeriod:${region.duoarea}`;
      try {
        const points = await fetchFuelMarketHistory(2, region.duoarea);
        const [latest] = points;
        if (!latest) throw new Error(`EIA returned no diesel data for ${region.label}.`);
        nextState[stateKey] = latest.period;
        if (state[stateKey] === latest.period) continue;
        const signal = buildRegionalDieselSignal(region, points, observedAt);
        if (signal) signals.push(signal);
      } catch (err) {
        failures.push(`${region.label}: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }

    if (failures.length === DIESEL_REGIONS.length) {
      return {
        watcherKey: EIA_REGIONAL_WATCHER_KEY,
        status: "error",
        message: `All regional diesel polls failed: ${failures.join("; ")}`,
        signals: [],
        state: {},
      };
    }
    return {
      watcherKey: EIA_REGIONAL_WATCHER_KEY,
      status: "ok",
      message: failures.length > 0 ? `Partial coverage: ${failures.join("; ")}` : null,
      signals,
      state: nextState,
    };
  },
};
