// Task 4.1 (TASKS.md). Fuel-market source for the industry-intelligence
// engine (docs/design/ai-architecture.md) - the EIA (U.S. Energy
// Information Administration) Open Data API v2, free, official government
// data, matching the project's "free/near-free to start" budget.
//
// VERIFICATION NOTE (be honest about this, don't overclaim): this
// implementation was written from documented knowledge of the EIA v2 API's
// general shape (route/facets/response envelope), not confirmed against a
// live call. This sandbox's network egress blocks outbound HTTPS to
// arbitrary external domains entirely - confirmed by testing api.eia.gov
// directly (curl: "CONNECT tunnel failed, response 403"), the same
// restriction already documented for *.supabase.co. The response is
// validated strictly with Zod below specifically so a wrong assumption
// fails loudly and explicitly (triggering the existing "source
// unreachable, no partial briefing" failure path from docs/automation.md)
// rather than silently producing wrong fuel-price data. Verify against a
// real call - e.g. via the manual-trigger debug route (task 4.3) - once
// this runs somewhere with real internet access (Fly.io); update this
// note once that's actually been done.

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
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    throw new Error("EIA_API_KEY is not configured.");
  }

  const url = new URL(EIA_SERIES_URL);
  url.searchParams.set("api_key", apiKey);
  for (const [key, value] of Object.entries(EIA_QUERY_PARAMS)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`EIA API request failed: ${res.status} ${res.statusText}`);
  }

  // Untrusted external content (CLAUDE.md) - parsed and validated, never
  // treated as instructions or trusted without a schema check.
  const json: unknown = await res.json();
  const parsed = eiaResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`EIA API response didn't match the expected shape: ${parsed.error.message}`);
  }

  const latest = parsed.data.response.data[0];
  if (!latest) {
    throw new Error("EIA API response's data array was unexpectedly empty after validation.");
  }
  return {
    label: "U.S. average diesel retail price",
    period: latest.period,
    pricePerGallon: latest.value,
    units: latest.units,
  };
}
