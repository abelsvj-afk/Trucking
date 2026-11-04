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
// repeated both ways). So we always send the UA.
//
// THROTTLING, ROUND 2 (live-verified 2026-11-04): the UA fix was not
// enough in production - gdelt_geo died with a raw "fetch failed" and
// gdelt_tech lost 3 of its 4 query sets to 429s in the same tick.
// Reproduced from a sandbox: GDELT throttles PER EGRESS IP, and Fly's
// egress IPs are shared with countless other tenants, so the budget
// is erratic - a lone request can 429 while an immediate retry
// succeeds, and GDELT drops connections outright under load. Two
// defenses, both in this shared client so every caller gets them:
// - PACING: request starts are spaced process-wide by GDELT_PACE_MS,
//   so our own bursts (geo's poll followed by tech's four query sets,
//   fired back-to-back by the serial watcher runner) never collide
//   with each other when the IP does have budget.
// - RETRIES: up to 3 attempts on the two transient failure flavors -
//   HTTP 429 and a network-level throw ("fetch failed") - waiting
//   GDELT_RETRY_DELAY_MS, then GDELT_FINAL_RETRY_DELAY_MS. Non-429
//   HTTP errors are not retried. The final failure keeps the visible
//   "GDELT request failed: ..." shape, cause included.

import { z } from "zod";

export const GDELT_USER_AGENT = "TruckingResearchEngine/1.0 (owner-operator research bot)";

/** GDELT's published floor is one request per 5 seconds per IP; first retry sits just past it. */
export const GDELT_RETRY_DELAY_MS = 6_000;

/** Final retry waits longer - a saturated shared egress IP needs a wider window to clear. */
export const GDELT_FINAL_RETRY_DELAY_MS = 15_000;

/** Minimum spacing between GDELT request starts anywhere in this process. */
export const GDELT_PACE_MS = 5_500;

const GDELT_MAX_ATTEMPTS = 3;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Process-wide pacing gate: a promise chain every GDELT call queues
// on, so request starts stay spaced even across watchers (the runner
// polls serially, but geo and tech share this client within a tick).
let gdeltGate: Promise<void> = Promise.resolve();
let lastGdeltRequestStart = 0;

async function awaitGdeltTurn(paceMs: number): Promise<void> {
  const turn = gdeltGate.then(async () => {
    const waitMs = lastGdeltRequestStart + paceMs - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    lastGdeltRequestStart = Date.now();
  });
  // A failed turn must not poison the chain for the next caller.
  gdeltGate = turn.then(
    () => undefined,
    () => undefined,
  );
  await turn;
}

export async function fetchGdeltArticles(
  timespan: string = "48h",
  maxRecords: number = 75,
  fetchFn: typeof fetch = fetch,
  query: string = GDELT_QUERY,
  retryDelayMs: number = GDELT_RETRY_DELAY_MS,
  paceMs: number = GDELT_PACE_MS,
  finalRetryDelayMs: number = GDELT_FINAL_RETRY_DELAY_MS,
): Promise<GdeltArticle[]> {
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", query);
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("timespan", timespan);
  url.searchParams.set("maxrecords", String(maxRecords));
  url.searchParams.set("sort", "datedesc");

  await awaitGdeltTurn(paceMs);

  const retryDelaysMs = [retryDelayMs, finalRetryDelayMs];
  let lastFailure: Error | null = null;
  for (let attempt = 0; attempt < GDELT_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(retryDelaysMs[attempt - 1] ?? finalRetryDelayMs);

    let res: Response;
    try {
      res = await fetchFn(url, {
        headers: { "User-Agent": GDELT_USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      // Network-level failure - GDELT drops connections under load
      // (production gdelt_geo: "fetch failed"). Same retry schedule
      // as a 429; the cause stays in the final error message.
      lastFailure = new Error(`GDELT request failed: ${err instanceof Error ? err.message : "network error"}`);
      continue;
    }

    if (res.status === 429) {
      lastFailure = new Error(`GDELT request failed: ${res.status} ${res.statusText}`);
      continue;
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

  throw lastFailure ?? new Error("GDELT request failed.");
}
