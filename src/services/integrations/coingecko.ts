// CoinGecko public API client - the crypto snapshot watcher's ONLY
// source (docs/design/autonomous-research.md §2). Free and KEYLESS:
// the public /simple/price endpoint needs no account, no key, and no
// secret, which is exactly the free-first posture the research engine
// runs on. Prices only - this client can read a price and nothing
// else; it holds no keys, signs nothing, and cannot touch an account
// or a loan. Response strictly Zod-validated; a shape mismatch fails
// loudly into the watcher's visible error state instead of producing
// a plausible wrong number.

import { z } from "zod";

const COINGECKO_PRICE_URL = "https://api.coingecko.com/api/v3/simple/price";

/** The two assets behind the owner's collateral context. Awareness only. */
export const CRYPTO_ASSETS = [
  { id: "bitcoin", symbol: "BTC" },
  { id: "ripple", symbol: "XRP" },
] as const;

const priceResponseSchema = z.record(
  z.string(),
  z.object({
    usd: z.number(),
    usd_24h_change: z.number().optional(),
  }),
);

export interface CryptoPrice {
  id: string;
  symbol: string;
  priceUsd: number;
  change24hPct: number | null;
}

/**
 * Fetches current USD prices for BTC + XRP. Throws on any failure
 * (network, non-200, shape) - the watcher turns that into its visible
 * error state. A missing asset in an otherwise valid response also
 * throws: a half snapshot presented as whole would be a wrong fact.
 */
export async function fetchCryptoPrices(fetchFn: typeof fetch = fetch): Promise<CryptoPrice[]> {
  const ids = CRYPTO_ASSETS.map((a) => a.id).join(",");
  const url = `${COINGECKO_PRICE_URL}?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
  const response = await fetchFn(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`CoinGecko answered HTTP ${response.status} for the crypto price snapshot.`);
  }
  const parsed = priceResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("CoinGecko's crypto price response did not match the expected shape.");
  }
  return CRYPTO_ASSETS.map((asset) => {
    const row = parsed.data[asset.id];
    if (!row) throw new Error(`CoinGecko's response carried no price for ${asset.symbol}.`);
    return {
      id: asset.id,
      symbol: asset.symbol,
      priceUsd: row.usd,
      change24hPct: typeof row.usd_24h_change === "number" ? row.usd_24h_change : null,
    };
  });
}
