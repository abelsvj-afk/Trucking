// Smart Path Piece 1 (P1-6): the honest fuel-price estimate tier.
//
// There is no free station-level diesel price API. What is free,
// official, and already integrated in this repo is the EIA weekly
// U.S. average diesel retail price (src/services/integrations/eia.ts).
// This module turns that snapshot into the estimate attached to
// map-found fuel candidates. It is always labeled as the EIA average
// it is - never presented as a station's price - and any failure
// (missing EIA_API_KEY, timeout, bad shape) degrades to null: the
// route check then ranks those candidates on detour alone, exactly
// as it did before estimates existed. This module never throws.

import {
  fetchFuelMarketSnapshot,
  type FuelMarketSnapshot,
} from "@/services/integrations/eia";

export interface DieselPriceEstimate {
  cents: number;
  label: string;
}

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * "Oct 26" for the snapshot's period, or null when the period can't
 * be read as a date. EIA periods arrive as YYYY-MM-DD; that form is
 * parsed field-by-field so the day never shifts with the reader's
 * timezone, and other date-ish strings go through Date.parse with
 * UTC getters for the same reason.
 */
function formatPeriod(period: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(period.trim());
  if (iso) {
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${MONTHS_SHORT[month - 1]} ${day}`;
    }
    return null;
  }
  const parsed = Date.parse(period);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  return `${MONTHS_SHORT[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/**
 * Pure snapshot -> estimate conversion. Returns null when the
 * snapshot carries no usable price (missing, non-numeric, or not
 * positive) - an estimate built on a bad figure would be a lie.
 */
export function dieselEstimateFromSnapshot(
  snapshot: FuelMarketSnapshot | null | undefined,
): DieselPriceEstimate | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const price = snapshot.pricePerGallon;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
  const period = typeof snapshot.period === "string" ? snapshot.period : "";
  const formatted = period ? formatPeriod(period) : null;
  return {
    cents: Math.round(price * 100),
    label: `EIA U.S. average, week of ${formatted ?? period}`,
  };
}

const MEMO_TTL_MS = 12 * 60 * 60_000; // EIA publishes weekly; 12h is plenty fresh.

// Module-level memo, keyed by the fetcher's identity: the production
// default (fetchFuelMarketSnapshot) is one stable function, so route
// checks share one EIA call per 12 hours, while injected test stubs
// (a fresh function per test) never read each other's cached values.
const memo = new WeakMap<
  () => Promise<FuelMarketSnapshot>,
  { fetchedAtMs: number; estimate: DieselPriceEstimate | null }
>();

/**
 * The current EIA diesel estimate, or null when it can't be had.
 * ANY error - missing key, a throw from the fetcher, a bad shape -
 * becomes null. Never throws into the route check.
 */
export async function getDieselPriceEstimate(
  fetcher: () => Promise<FuelMarketSnapshot> = fetchFuelMarketSnapshot,
): Promise<DieselPriceEstimate | null> {
  const cached = memo.get(fetcher);
  if (cached && Date.now() - cached.fetchedAtMs < MEMO_TTL_MS) {
    return cached.estimate;
  }
  let estimate: DieselPriceEstimate | null;
  try {
    estimate = dieselEstimateFromSnapshot(await fetcher());
  } catch {
    estimate = null;
  }
  // Only a real estimate is memoized: a failure (e.g. the key not yet
  // configured) must not suppress the price for the next 12 hours.
  if (estimate !== null) {
    memo.set(fetcher, { fetchedAtMs: Date.now(), estimate });
  }
  return estimate;
}
