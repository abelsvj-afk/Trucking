// Task 4.1 (TASKS.md). Fuel-market source for the industry-intelligence
// engine (docs/design/ai-architecture.md) - the EIA (U.S. Energy
// Information Administration) Open Data API v2, free, official government
// data, matching the project's "free/near-free to start" budget.
//
// VERIFICATION NOTE (updated 2026-11-03): the request shape below is
// now LIVE-VERIFIED - the exact request this module builds returned
// HTTP 200 with real weekly diesel data when sent with the API key
// EIA emailed at registration. The 403s the watchers showed in
// production on 2026-11-03 were traced to the EIA_API_KEY value set
// on Fly not matching that emailed key: with no key EIA answers 403
// API_KEY_MISSING, with any wrong value 403 API_KEY_INVALID, and the
// production error carried no code because this module used to throw
// the body away - it now surfaces EIA's error code/message so the
// Research page names the actual failure (see fetchFuelMarketHistory).
// The response is still validated strictly with Zod so a wrong
// assumption fails loudly and explicitly (triggering the existing
// "source unreachable, no partial briefing" failure path from
// docs/automation.md) rather than silently producing wrong data.

import { z } from "zod";

const EIA_SERIES_URL = "https://api.eia.gov/v2/petroleum/pri/gnd/data/";

// U.S. average, all types of diesel, retail price ($/gal) - the EIA v2
// facet values for this specific series (product=EPD2D, duoarea=NUS).
const EIA_QUERY_PARAMS = {
  frequency: "weekly",
  "data[0]": "value",
  "facets[product][]": "EPD2D",
  "facets[duoarea][]": "NUS",
  "sort[0][column]": "period",
  "sort[0][direction]": "desc",
  length: "1",
};

export interface FuelMarketPoint {
  period: string;
  pricePerGallon: number;
  units: string;
}

/**
 * The most recent `limit` weekly points, newest first. The research
 * engine's diesel watcher (docs/design/research-engine.md §2) needs the
 * last two to compute a week-over-week move; fetchFuelMarketSnapshot
 * below keeps its Stage-4 single-point shape on top of this.
 *
 * `duoarea` selects the EIA geography facet: 'NUS' (U.S. average,
 * the default and the Stage-4 behavior) or a PADD code ('R10' = PADD 1
 * East Coast, 'R30' = PADD 3 Gulf Coast) for the regional diesel
 * watcher (2026-11-02 design, D-3).
 */
export async function fetchFuelMarketHistory(limit: number, duoarea: string = "NUS"): Promise<FuelMarketPoint[]> {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    throw new Error("EIA_API_KEY is not configured.");
  }

  const url = new URL(EIA_SERIES_URL);
  url.searchParams.set("api_key", apiKey);
  for (const [key, value] of Object.entries(EIA_QUERY_PARAMS)) {
    url.searchParams.set(key, key === "length" ? String(limit) : value);
  }
  url.searchParams.set("facets[duoarea][]", duoarea);

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`EIA API request failed: ${res.status} ${res.statusText}${await eiaErrorDetail(res)}`);
  }

  const json: unknown = await res.json();
  const parsed = eiaResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`EIA API response didn't match the expected shape: ${parsed.error.message}`);
  }

  return parsed.data.response.data.map((point) => ({
    period: point.period,
    pricePerGallon: point.value,
    units: point.units,
  }));
}

const eiaErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string().optional(),
  }),
});

/**
 * EIA explains its own failures in the error body (e.g. 403 with code
 * API_KEY_INVALID vs API_KEY_MISSING - the difference between "the
 * configured key is wrong" and "no key reached EIA"). Surface that
 * code in the watcher's visible error; any unreadable body degrades
 * to the plain status line.
 */
async function eiaErrorDetail(res: Response): Promise<string> {
  try {
    const parsed = eiaErrorSchema.safeParse(JSON.parse(await res.text()));
    if (!parsed.success) return "";
    const { code, message } = parsed.data.error;
    return message ? ` (${code}: ${message})` : ` (${code})`;
  } catch {
    return "";
  }
}

const eiaResponseSchema = z.object({
  response: z.object({
    data: z
      .array(
        z.object({
          period: z.string(),
          value: z.number(),
          units: z.string(),
        }),
      )
      .min(1, "EIA returned no data points for the requested series."),
  }),
});

export interface FuelMarketSnapshot {
  label: string;
  period: string;
  pricePerGallon: number;
  units: string;
}

export async function fetchFuelMarketSnapshot(): Promise<FuelMarketSnapshot> {
  // Untrusted external content (CLAUDE.md) - parsed and validated inside
  // fetchFuelMarketHistory, never trusted without the schema check.
  const [latest] = await fetchFuelMarketHistory(1);
  if (!latest) {
    throw new Error("EIA API response's data array was unexpectedly empty after validation.");
  }
  return {
    label: "U.S. average diesel retail price",
    period: latest.period,
    pricePerGallon: latest.pricePerGallon,
    units: latest.units,
  };
}
