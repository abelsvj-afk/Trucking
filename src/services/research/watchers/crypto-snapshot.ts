// Deep Research Engine watcher: crypto snapshot (docs/design/
// autonomous-research.md §2). One daily observation from CoinGecko's
// free keyless public API - BTC and XRP USD prices with their 24h
// moves. The owner holds BTC/XRP as collateral behind Coinbase loans,
// so Abel keeps AWARENESS of what the market is doing around that
// cushion. Awareness only, by construction AND by rule:
// - the signal's magnitude is a flat 0.25 from a single source, which
//   can never cross the convergence fire line (1.6) or any hard
//   trigger (signalCrossesThreshold has no coingecko case) - this
//   watcher informs the knowledge layer, it never starts a run;
// - nothing here touches an account, a loan, or a trade; the copy
//   never frames a move as advice.
// A failed fetch lands as a visible 'error' state (the family's
// never-silent rule) - never a fabricated price.

import { fetchCryptoPrices, type CryptoPrice } from "@/services/integrations/coingecko";
import type { PressureSignal, Watcher, WatcherResult } from "./types";

export const CRYPTO_WATCHER_KEY = "coingecko_crypto";

function fmtPrice(price: number): string {
  return price >= 100
    ? `$${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : `$${price.toFixed(price >= 1 ? 2 : 4)}`;
}

function fmtChange(pct: number | null): string {
  if (pct === null) return "24h move not reported";
  return `${pct >= 0 ? "up" : "down"} ${Math.abs(pct).toFixed(1)}% in 24h`;
}

/** Builds the daily snapshot signal from fetched prices. Pure - unit-tested. */
export function buildCryptoSignal(prices: CryptoPrice[], observedAt: string): PressureSignal {
  const day = observedAt.slice(0, 10);
  const parts = prices.map((p) => `${p.symbol} ${fmtPrice(p.priceUsd)} (${fmtChange(p.change24hPct)})`);
  return {
    watcherKey: CRYPTO_WATCHER_KEY,
    kind: "crypto_snapshot",
    topic: "crypto",
    magnitude: 0.25,
    summary: `Crypto snapshot (${day}): ${parts.join(", ")}. Awareness only - the market around his BTC/XRP collateral, not a trading signal.`,
    items: prices.map((p) => ({
      title: `${p.symbol} price - ${day}`,
      url: "https://www.coingecko.com/",
      publishedAt: day,
      summary: `${fmtPrice(p.priceUsd)}, ${fmtChange(p.change24hPct)}.`,
    })),
    data: {
      prices: Object.fromEntries(prices.map((p) => [p.symbol, p.priceUsd])),
      changes24hPct: Object.fromEntries(prices.map((p) => [p.symbol, p.change24hPct])),
      asOf: observedAt,
    },
    dedupeKey: `crypto_snapshot:${day}`,
    observedAt,
  };
}

export const cryptoSnapshotWatcher: Watcher = {
  key: CRYPTO_WATCHER_KEY,
  async poll(state: Record<string, unknown>): Promise<WatcherResult> {
    const observedAt = new Date().toISOString();
    const day = observedAt.slice(0, 10);

    if (state.lastSnapshotDay === day) {
      return { watcherKey: CRYPTO_WATCHER_KEY, status: "ok", message: null, signals: [], state: {} };
    }

    let prices: CryptoPrice[];
    try {
      prices = await fetchCryptoPrices();
    } catch (err) {
      return {
        watcherKey: CRYPTO_WATCHER_KEY,
        status: "error",
        message: `Crypto snapshot failed this poll - ${err instanceof Error ? err.message : "unknown error"}`,
        signals: [],
        state: {},
      };
    }

    return {
      watcherKey: CRYPTO_WATCHER_KEY,
      status: "ok",
      message: null,
      signals: [buildCryptoSignal(prices, observedAt)],
      state: { lastSnapshotDay: day },
    };
  },
};
