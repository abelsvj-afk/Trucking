// FRED (Federal Reserve Economic Data) client - the market watcher's
// ONLY source since the 2026-11-03 Stooq -> FRED switch: Stooq's CSV
// endpoints sit behind a JavaScript browser-verification wall no
// server client can pass (live-proven, MARKETS-FRED record), so the
// watcher polls FRED daily series (SP500, DJTA, DCOILWTICO, DHHNGSP)
// plus GASDESW weekly diesel. Free key from fred.stlouisfed.org; the
// watcher skips visibly without FRED_API_KEY. Response strictly
// Zod-validated; a shape mismatch fails loudly into the watcher's
// visible message.

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

/**
 * % change between the newest numeric observation and the one
 * `stepsBack` numeric observations earlier (desc-order input, as
 * fetchFredSeries returns). For FRED's daily business-day series,
 * 5 steps back is one trading week - the same read the Stooq-era
 * watcher took from 6 daily closes. Non-numeric observations ("." -
 * holidays/gaps) are skipped, never counted as steps. Returns null
 * when history is too thin or the base value is not positive.
 */
export function fredChangeOverSteps(observations: FredPoint[], stepsBack: number = 5): number | null {
  const numeric = observations.filter((o) => Number.isFinite(o.value));
  const latest = numeric[0];
  const prior = numeric[stepsBack];
  if (!latest || !prior || prior.value <= 0) return null;
  return ((latest.value - prior.value) / prior.value) * 100;
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
