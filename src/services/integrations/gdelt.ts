// GDELT 2.0 source for the Deep Research Engine (2026-11-02 design,
// D-3): the free, keyless global news-event ear - the "news overseas
// that moves stocks and fuel" watcher. Uses the DOC 2.0 artlist API
// with a shipping/energy-supply query. Response strictly Zod-
// validated; GDELT rate-limits aggressively, so a failure is a
// visible watcher error, never a fabricated quiet day.

import { z } from "zod";

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
  query: string = GDELT_QUERY,
): Promise<GdeltArticle[]> {
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", query);
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("timespan", timespan);
  url.searchParams.set("maxrecords", String(maxRecords));
  url.searchParams.set("sort", "datedesc");

  const res = await fetchFn(url, { signal: AbortSignal.timeout(20_000) });
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
