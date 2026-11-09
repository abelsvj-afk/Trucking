// Crypto snapshot watcher (docs/design/autonomous-research.md §2):
// one daily CoinGecko observation, awareness only - proven here by
// the trigger math itself: a crypto snapshot can never hard-fire and
// one source alone can never reach the convergence fire line.

import { describe, expect, it } from "vitest";
import { fetchCryptoPrices } from "@/services/integrations/coingecko";
import { getResearchConfig } from "@/services/research/config";
import { topicConvergenceScore } from "@/services/research/scoring";
import { signalCrossesThreshold } from "@/services/research/triggers";
import { buildCryptoSignal, CRYPTO_WATCHER_KEY } from "@/services/research/watchers/crypto-snapshot";

const config = getResearchConfig({} as NodeJS.ProcessEnv);
const OBSERVED = "2026-11-09T12:00:00Z";
const PRICES = [
  { id: "bitcoin", symbol: "BTC", priceUsd: 81234.5, change24hPct: -2.34 },
  { id: "ripple", symbol: "XRP", priceUsd: 2.41, change24hPct: 1.05 },
];

describe("buildCryptoSignal", () => {
  it("builds a dated daily snapshot naming both prices and moves", () => {
    const signal = buildCryptoSignal(PRICES, OBSERVED);
    expect(signal.watcherKey).toBe(CRYPTO_WATCHER_KEY);
    expect(signal.topic).toBe("crypto");
    expect(signal.dedupeKey).toBe("crypto_snapshot:2026-11-09");
    expect(signal.summary).toContain("BTC $81,235");
    expect(signal.summary).toContain("down 2.3% in 24h");
    expect(signal.summary).toContain("XRP $2.41");
    expect(signal.summary).toContain("Awareness only");
    expect(signal.items).toHaveLength(2);
  });

  it("can never hard-fire a research run on its own", () => {
    const signal = buildCryptoSignal(PRICES, OBSERVED);
    expect(signalCrossesThreshold(signal, config)).toBe(false);
  });

  it("one daily source can never reach the convergence fire line", () => {
    const signal = buildCryptoSignal(PRICES, OBSERVED);
    const score = topicConvergenceScore([signal], "crypto", new Date(OBSERVED), config);
    expect(score).toBeLessThan(config.convergenceFireScore);
  });
});

describe("fetchCryptoPrices", () => {
  const okResponse = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as Response;

  it("parses the keyless public response", async () => {
    const fetchFn = async () =>
      okResponse({
        bitcoin: { usd: 81234.5, usd_24h_change: -2.34 },
        ripple: { usd: 2.41, usd_24h_change: 1.05 },
      });
    const prices = await fetchCryptoPrices(fetchFn as typeof fetch);
    expect(prices).toEqual(PRICES);
  });

  it("fails loudly on a non-200 instead of inventing a price", async () => {
    const fetchFn = async () => ({ ok: false, status: 429, json: async () => ({}) }) as Response;
    await expect(fetchCryptoPrices(fetchFn as typeof fetch)).rejects.toThrow("429");
  });

  it("fails loudly when an asset is missing from the response", async () => {
    const fetchFn = async () => okResponse({ bitcoin: { usd: 81234.5 } });
    await expect(fetchCryptoPrices(fetchFn as typeof fetch)).rejects.toThrow("XRP");
  });
});
