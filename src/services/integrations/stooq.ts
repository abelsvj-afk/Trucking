// Market snapshot source for the Deep Research Engine (2026-11-02
// design, D-3): Stooq's free, keyless daily-history CSVs. Written
// from Stooq's documented CSV shape (Date,Open,High,Low,Close,Volume)
// and validated strictly with Zod - a wrong assumption must fail
// loudly (the watcher records a visible error), never produce a
// plausible-but-wrong market number. Verify against a live call once
// this runs somewhere with real internet access.

import { z } from "zod";

export interface MarketSeriesPoint {
  date: string;
  close: number;
}

const rowSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  close: z.coerce.number().positive(),
});

/** Parses a Stooq daily-history CSV into points, oldest first. Pure - unit-tested. */
export function parseStooqHistory(csv: string): MarketSeriesPoint[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2 || !lines[0]) throw new Error("Stooq returned no history rows.");
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const dateIdx = header.indexOf("date");
  const closeIdx = header.indexOf("close");
  if (dateIdx < 0 || closeIdx < 0) throw new Error("Stooq CSV is missing the Date/Close columns.");
  const points: MarketSeriesPoint[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split(",");
    const parsed = rowSchema.safeParse({ date: cols[dateIdx], close: cols[closeIdx] });
    if (parsed.success) points.push({ date: parsed.data.date, close: parsed.data.close });
  }
  if (points.length === 0) throw new Error("Stooq CSV contained no parseable rows.");
  return points;
}

/** Week-over-week % change: latest close vs the close 5 trading days earlier. */
export function weekOverWeekChange(points: MarketSeriesPoint[]): number | null {
  if (points.length < 6) return null;
  const latest = points[points.length - 1];
  const prior = points[points.length - 6];
  if (!latest || !prior || prior.close <= 0) return null;
  return ((latest.close - prior.close) / prior.close) * 100;
}

export async function fetchStooqHistory(symbol: string, fetchFn: typeof fetch = fetch): Promise<MarketSeriesPoint[]> {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Stooq request for ${symbol} failed: ${res.status} ${res.statusText}`);
  return parseStooqHistory(await res.text());
}
