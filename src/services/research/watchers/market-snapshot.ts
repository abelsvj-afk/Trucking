// Deep Research Engine watcher: market snapshot (2026-11-02 design,
// D-3). One daily observation from free sources - S&P 500 and Dow
// Transports (the freight economy's stock pulse), WTI crude, natural
// gas (Stooq, keyless), plus FRED's weekly diesel series when its
// free key is present. The snapshot NEVER hard-fires on its own; big
// crude/Transports moves become convergence pressure through
// scoring.ts's marketPressureSignals (that's the design: market data
// corroborates, trucking data leads).

import { fetchFredSeries, fredWeekOverWeek } from "@/services/integrations/fred";
import { fetchStooqHistory, weekOverWeekChange, type MarketSeriesPoint } from "@/services/integrations/stooq";
import type { PressureSignal, Watcher, WatcherResult } from "./types";

export const MARKET_WATCHER_KEY = "stooq_market";
export const FRED_DIESEL_SERIES = "GASDESW";

const SYMBOLS = {
  spx: "^spx",
  transports: "^djt",
  crude: "cl.f",
  natgas: "ng.f",
} as const;

export interface MarketSnapshotData {
  spxWowPct: number | null;
  transportsWowPct: number | null;
  crudeWowPct: number | null;
  natgasWowPct: number | null;
  fredDieselWowPct: number | null;
  asOf: string;
}

function fmtPct(pct: number | null): string {
  if (pct === null) return "n/a";
  return `${pct >= 0 ? "up" : "down"} ${Math.abs(pct).toFixed(1)}%`;
}

/** Builds the daily snapshot signal. Pure - unit-tested on fixture series. */
export function buildMarketSignal(
  series: { spx: MarketSeriesPoint[]; transports: MarketSeriesPoint[]; crude: MarketSeriesPoint[]; natgas: MarketSeriesPoint[] },
  fredDieselWowPct: number | null,
  observedAt: string,
): PressureSignal {
  const data: MarketSnapshotData = {
    spxWowPct: weekOverWeekChange(series.spx),
    transportsWowPct: weekOverWeekChange(series.transports),
    crudeWowPct: weekOverWeekChange(series.crude),
    natgasWowPct: weekOverWeekChange(series.natgas),
    fredDieselWowPct,
    asOf: observedAt,
  };
  const day = observedAt.slice(0, 10);
  return {
    watcherKey: MARKET_WATCHER_KEY,
    kind: "market_snapshot",
    topic: "market",
    magnitude: 0.3,
    summary:
      `Market snapshot (${day}): S&P 500 ${fmtPct(data.spxWowPct)} WoW, Dow Transports ${fmtPct(data.transportsWowPct)}, ` +
      `WTI crude ${fmtPct(data.crudeWowPct)}, natural gas ${fmtPct(data.natgasWowPct)}` +
      (fredDieselWowPct !== null ? `, FRED diesel ${fmtPct(fredDieselWowPct)}.` : "."),
    items: [
      {
        title: `Market snapshot - ${day}`,
        url: "https://stooq.com/",
        publishedAt: day,
        summary: `Transports ${fmtPct(data.transportsWowPct)} WoW; crude ${fmtPct(data.crudeWowPct)} WoW.`,
      },
    ],
    data: { ...data },
    dedupeKey: `market_snapshot:${day}`,
    observedAt,
  };
}

export const marketSnapshotWatcher: Watcher = {
  key: MARKET_WATCHER_KEY,
  async poll(state: Record<string, unknown>): Promise<WatcherResult> {
    const observedAt = new Date().toISOString();
    const day = observedAt.slice(0, 10);
    if (state.lastSnapshotDay === day) {
      return { watcherKey: MARKET_WATCHER_KEY, status: "ok", message: null, signals: [], state: {} };
    }
    try {
      const [spx, transports, crude, natgas] = await Promise.all([
        fetchStooqHistory(SYMBOLS.spx),
        fetchStooqHistory(SYMBOLS.transports),
        fetchStooqHistory(SYMBOLS.crude),
        fetchStooqHistory(SYMBOLS.natgas),
      ]);

      let fredDieselWowPct: number | null = null;
      let fredNote: string | null = null;
      if (process.env.FRED_API_KEY) {
        try {
          fredDieselWowPct = fredWeekOverWeek(await fetchFredSeries(FRED_DIESEL_SERIES));
        } catch (err) {
          fredNote = `FRED enrichment failed: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      } else {
        fredNote = "FRED_API_KEY not set - market snapshot runs on Stooq only (optional free key, owner setup item).";
      }

      const signal = buildMarketSignal({ spx, transports, crude, natgas }, fredDieselWowPct, observedAt);
      return {
        watcherKey: MARKET_WATCHER_KEY,
        status: "ok",
        message: fredNote,
        signals: [signal],
        state: { lastSnapshotDay: day },
      };
    } catch (err) {
      return {
        watcherKey: MARKET_WATCHER_KEY,
        status: "error",
        message: err instanceof Error ? err.message : "Unknown error polling market sources.",
        signals: [],
        state: {},
      };
    }
  },
};
