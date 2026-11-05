// Smart Path intelligence, Phase 2a (docs/design/smart-path-intelligence.md §2.1):
// the EIA weekly retail diesel average for a PADD region, labeled as that region's
// AVERAGE - never as a station's price. Free (the EIA key already in use). Any
// failure is null; a snapshot older than STALE_DAYS is returned flagged stale so the
// caller shows it with its date but does not rank on it. Never throws.

import { fetchFuelMarketHistory, type FuelMarketPoint } from "@/services/integrations/eia";

export const AGING_DAYS = 8;
export const STALE_DAYS = 10;
const MEMO_TTL_MS = 6 * 60 * 60_000;

export type Freshness = "fresh" | "aging" | "stale";

export interface RegionalDiesel {
  paddCode: string;
  regionName: string;
  cents: number;
  /** "EIA Gulf Coast weekly average, week of Nov 3 - not this station's price" */
  label: string;
  period: string;
  freshness: Freshness;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function regionalDieselFromPoint(
  paddCode: string,
  regionName: string,
  point: FuelMarketPoint | undefined,
  now: Date,
): RegionalDiesel | null {
  if (!point || !Number.isFinite(point.pricePerGallon) || point.pricePerGallon <= 0) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(point.period);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return null;
  const ageDays = (now.getTime() - Date.UTC(Number(m[1]), month - 1, day)) / 86_400_000;
  const freshness: Freshness = ageDays >= STALE_DAYS ? "stale" : ageDays >= AGING_DAYS ? "aging" : "fresh";
  return {
    paddCode,
    regionName,
    cents: Math.round(point.pricePerGallon * 100),
    label: `EIA ${regionName} weekly average, week of ${MONTHS[month - 1]} ${day} - not this station's price`,
    period: point.period,
    freshness,
  };
}

const memo = new Map<string, { at: number; value: RegionalDiesel }>();

export async function getRegionalDiesel(
  paddCode: string,
  regionName: string,
  fetcher: (limit: number, duoarea: string) => Promise<FuelMarketPoint[]> = fetchFuelMarketHistory,
  now: Date = new Date(),
): Promise<RegionalDiesel | null> {
  const key = `${paddCode}`;
  const cached = fetcher === fetchFuelMarketHistory ? memo.get(key) : undefined;
  if (cached && now.getTime() - cached.at < MEMO_TTL_MS) return cached.value;
  try {
    const points = await fetcher(1, paddCode);
    const value = regionalDieselFromPoint(paddCode, regionName, points[0], now);
    if (value && fetcher === fetchFuelMarketHistory) memo.set(key, { at: now.getTime(), value });
    return value;
  } catch {
    return null;
  }
}
