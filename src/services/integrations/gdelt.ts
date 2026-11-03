// GDELT 2.0 source for the Deep Research Engine (2026-11-02 design,
// D-3): the free, keyless global news-event ear - the "news overseas
// that moves stocks and fuel" watcher. Uses the DOC 2.0 artlist API
// with a shipping/energy-supply query. Response strictly Zod-
// validated; GDELT rate-limits aggressively, so a failure is a
// visible watcher error, never a fabricated quiet day.
//
// IDENTIFICATION (live-verified 2026-11-03): GDELT throttles clients
// that don't identify themselves - the exact production request with
// no User-Agent returned 429 ("Please limit requests to one every 5
// seconds...") while the same request seconds later with the honest
// User-Agent below returned 200 with real results (controlled A/B,
// repeated both ways). So we always send the UA, and on a 429 we
// honor their published one-per-5-seconds rule with a single retry
// after a 6-second pause before giving up into the visible error.

import { z } from "zod";

export const GDELT_USER_AGENT = "TruckingResearchEngine/1.0 (owner-operator research bot)";

/** GDELT's published floor is one request per 5 seconds; retry once, just past it. */
export const GDELT_RETRY_DELAY_MS = 6_000;

const gdeltResponseSchema = z.object({
  articles: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      domain: z.string().optional(),
      seendate: z.string().optional(),
    }),
  ),
});

export interface GdeltArticle {
  title: string;
  url: string;
  domain: string | null;
  seenDate: string | null;
}

export const GDELT_QUERY =
  "(shipping OR port OR \"red sea\" OR hormuz OR opec OR \"oil supply\" OR tanker OR \"supply chain\")";

export async function fetchGdeltArticles(
  timespan: string = "48h",
  maxRecords: number = 75,
  fetchFn: typeof fetch = fetch,
  retryDelayMs: number = GDELT_RETRY_DELAY_MS,
): Promise<GdeltArticle[]> {
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", GDELT_QUERY);
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("timespan", timespan);
  url.searchParams.set("maxrecords", String(maxRecords));
  url.searchParams.set("sort", "datedesc");

  let res = await fetchFn(url, {
    headers: { "User-Agent": GDELT_USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429) {
    // One retry past GDELT's published 5-second floor - a colliding
    // request a moment earlier (ours or another tenant's on a shared
    // egress IP) is the usual cause, not a hard daily cap.
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    res = await fetchFn(url, {
      headers: { "User-Agent": GDELT_USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
  }
  if (!res.ok) throw new Error(`GDELT request failed: ${res.status} ${res.statusText}`);
  const parsed = gdeltResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`GDELT response didn't match the expected shape: ${parsed.error.message}`);
  }
  return parsed.data.articles.map((a) => ({
    title: a.title,
    url: a.url,
    domain: a.domain ?? null,
    seenDate: a.seendate ?? null,
  }));
}
