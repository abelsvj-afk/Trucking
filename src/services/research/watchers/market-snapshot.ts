// Deep Research Engine watcher: market snapshot (2026-11-02 design,
// D-3; source switched Stooq -> FRED 2026-11-03 on the owner's call).
// One daily observation from FRED daily series - S&P 500 (SP500) and
// Dow Jones Transportation Average (DJTA, the freight economy's stock
// pulse), WTI crude spot (DCOILWTICO), Henry Hub natural gas spot
// (DHHNGSP) - plus FRED's weekly diesel series (GASDESW) as a second
// read on the EIA number. Stooq's keyless CSVs were the original
// source, but Stooq put them behind a JavaScript browser-verification
// wall no server client can pass (live-proven), so FRED - whose free
// key the owner obtained for this switch - carries every series.
// Semantics shift, named honestly: futures quotes (Stooq cl.f/ng.f)
// become spot prices; the watcher reads market direction, not
// tradable quotes, so spot is the honest equivalent. The snapshot
// NEVER hard-fires on its own; big crude/Transports moves become
// convergence pressure through scoring.ts's marketPressureSignals
// (that's the design: market data corroborates, trucking data leads).
//
// Without FRED_API_KEY the watcher skips VISIBLY (the OpenStates
// pattern) - the Research page shows exactly why nothing is being
// watched. A single series failing degrades the snapshot (that read
// is null, the poll message names the series); only all four market
// series failing is an error, and even that never throws out of poll.

import { fetchFredSeries, fredChangeOverSteps, fredWeekOverWeek, type FredPoint } from "@/services/integrations/fred";
import type { PressureSignal, Watcher, WatcherResult } from "./types";

export const MARKET_WATCHER_KEY = "fred_market";
export const FRED_DIESEL_SERIES = "GASDESW";

/** FRED series ids behind each snapshot read. DJTA is FRED's Dow Jones Transportation Average - the same index Stooq's ^djt mirrored. */
export const MARKET_SERIES = {
  spx: "SP500",
  transports: "DJTA",
  crude: "DCOILWTICO",
  natgas: "DHHNGSP",
} as const;

// Daily series: fetch enough observations that 6 numeric points (the
// WoW pair) survive holiday "." gaps.
const DAILY_FETCH_LIMIT = 10;

export interface MarketWowReads {
  spxWowPct: number | null;
  transportsWowPct: number | null;
  crudeWowPct: number | null;
  natgasWowPct: number | null;
}

export interface MarketSnapshotData extends MarketWowReads {
  fredDieselWowPct: number | null;
  asOf: string;
}

function fmtPct(pct: number | null): string {
  if (pct === null) return "n/a";
  return `${pct >= 0 ? "up" : "down"} ${Math.abs(pct).toFixed(1)}%`;
}

/** Builds the daily snapshot signal from precomputed WoW reads. Pure - unit-tested. */
export function buildMarketSignal(reads: MarketWowReads, fredDieselWowPct: number | null, observedAt: string): PressureSignal {
  const data: MarketSnapshotData = { ...reads, fredDieselWowPct, asOf: observedAt };
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
        url: "https://fred.stlouisfed.org/",
        publishedAt: day,
        summary: `Transports ${fmtPct(data.transportsWowPct)} WoW; crude ${fmtPct(data.crudeWowPct)} WoW.`,
      },
    ],
    data: { ...data },
    dedupeKey: `market_snapshot:${day}`,
    observedAt,
  };
}

/** Fetches one series' WoW read; a failure degrades to null + a named note, never a throw. */
async function fredWowOrNull(
  seriesId: string,
  wow: (points: FredPoint[]) => number | null,
  fetchLimit: number,
  failures: string[],
): Promise<number | null> {
  try {
    return wow(await fetchFredSeries(seriesId, fetchLimit));
  } catch (err) {
    failures.push(`${seriesId}: ${err instanceof Error ? err.message : "unknown error"}`);
    return null;
  }
}

export const marketSnapshotWatcher: Watcher = {
  key: MARKET_WATCHER_KEY,
  async poll(state: Record<string, unknown>): Promise<WatcherResult> {
    const observedAt = new Date().toISOString();
    const day = observedAt.slice(0, 10);

    if (!process.env.FRED_API_KEY) {
      return {
        watcherKey: MARKET_WATCHER_KEY,
        status: "skipped",
        message:
          "FRED_API_KEY is not set - market prices (S&P 500, Dow Transports, crude, natural gas, FRED diesel) are not being watched. Free key at fred.stlouisfed.org (owner setup item).",
        signals: [],
        state: {},
      };
    }

    if (state.lastSnapshotDay === day) {
      return { watcherKey: MARKET_WATCHER_KEY, status: "ok", message: null, signals: [], state: {} };
    }

    const failures: string[] = [];
    const [spxWowPct, transportsWowPct, crudeWowPct, natgasWowPct, fredDieselWowPct] = await Promise.all([
      fredWowOrNull(MARKET_SERIES.spx, (p) => fredChangeOverSteps(p, 5), DAILY_FETCH_LIMIT, failures),
      fredWowOrNull(MARKET_SERIES.transports, (p) => fredChangeOverSteps(p, 5), DAILY_FETCH_LIMIT, failures),
      fredWowOrNull(MARKET_SERIES.crude, (p) => fredChangeOverSteps(p, 5), DAILY_FETCH_LIMIT, failures),
      fredWowOrNull(MARKET_SERIES.natgas, (p) => fredChangeOverSteps(p, 5), DAILY_FETCH_LIMIT, failures),
      fredWowOrNull(FRED_DIESEL_SERIES, fredWeekOverWeek, 4, failures),
    ]);

    // Diesel failing alone never blocks the snapshot (it is the second
    // read on EIA); all four MARKET series failing means no snapshot.
    const marketFailureCount = failures.filter((f) => !f.startsWith(`${FRED_DIESEL_SERIES}:`)).length;
    if (marketFailureCount === Object.keys(MARKET_SERIES).length) {
      return {
        watcherKey: MARKET_WATCHER_KEY,
        status: "error",
        message: `All FRED market series failed this poll - ${failures.join("; ")}`,
        signals: [],
        state: {},
      };
    }

    const signal = buildMarketSignal({ spxWowPct, transportsWowPct, crudeWowPct, natgasWowPct }, fredDieselWowPct, observedAt);
    return {
      watcherKey: MARKET_WATCHER_KEY,
      status: "ok",
      message: failures.length > 0 ? `Partial FRED snapshot - failed series: ${failures.join("; ")}` : null,
      signals: [signal],
      state: { lastSnapshotDay: day },
    };
  },
};
