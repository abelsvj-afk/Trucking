// FRED (Federal Reserve Economic Data) source for the market
// watcher (2026-11-02 design, D-3): free key from fred.stlouisfed.org.
// Optional enrichment only - without FRED_API_KEY the market watcher
// runs on Stooq alone and says so in its poll message. The series
// used here is GASDESW, FRED's weekly U.S. diesel sales price, as a
// second read on the EIA number. Response strictly Zod-validated; a
// shape mismatch fails loudly into the watcher's visible message.

import { z } from "zod";

const fredResponseSchema = z.object({
  observations: z
    .array(
      z.object({
        date: z.string(),
        value: z.string(),
      }),
    )
    .min(1),
});

export interface FredPoint {
  date: string;
  value: number;
}

/** Week-over-week % change between the two newest numeric observations. */
export function fredWeekOverWeek(observations: FredPoint[]): number | null {
  const numeric = observations.filter((o) => Number.isFinite(o.value));
  const [latest, previous] = numeric;
  if (!latest || !previous || previous.value <= 0) return null;
  return ((latest.value - previous.value) / previous.value) * 100;
}

export async function fetchFredSeries(
  seriesId: string,
  limit: number = 4,
  fetchFn: typeof fetch = fetch,
): Promise<FredPoint[]> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error("FRED_API_KEY is not configured.");
  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", String(limit));

  const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`FRED request for ${seriesId} failed: ${res.status} ${res.statusText}`);
  const parsed = fredResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`FRED response for ${seriesId} didn't match the expected shape: ${parsed.error.message}`);
  }
  return parsed.data.observations.map((o) => ({ date: o.date, value: Number(o.value) }));
}
