// Smart Path intelligence, Phase 2b: the weather section of a route check.
// Samples at most MAX_POINTS corridor points, asks NWS for each (forecast read
// at the time he reaches that point), and reports a section that says plainly what
// it could and could not get: ok / partial / unavailable, never a silent blank.
// Cached in memory per ~1 km cell (forecast 30 min, alerts 10 min). Never throws.

import { mergeStretches, weatherItemsForPoint, type WeatherItem } from "@/lib/smart-path-weather";
import {
  fetchHourlyForecast,
  fetchPointAlerts,
  type HourlyPeriod,
  type PointAlert,
} from "@/services/integrations/nws-route";

export const MAX_POINTS = 12;
const FORECAST_TTL_MS = 30 * 60_000;
const ALERT_TTL_MS = 10 * 60_000;

export interface WeatherFetchers {
  hourly: (lat: number, lng: number) => Promise<HourlyPeriod[]>;
  alerts: (lat: number, lng: number) => Promise<PointAlert[]>;
}

export const defaultWeatherFetchers: WeatherFetchers = { hourly: fetchHourlyForecast, alerts: fetchPointAlerts };

export interface WeatherSection {
  status: "ok" | "partial" | "unavailable";
  items: (WeatherItem & { endMile: number })[];
  notes: string[];
  asOf: string;
}

export interface WeatherPoint {
  mile: number;
  lat: number;
  lng: number;
  etaAt: string | null;
}

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttl: number, now: Date, load: () => Promise<T>, useCache: boolean): Promise<T> {
  const hit = useCache ? cache.get(key) : undefined;
  if (hit && now.getTime() - hit.at < ttl) return hit.value as T;
  const value = await load();
  if (useCache) cache.set(key, { at: now.getTime(), value });
  return value;
}

function sample(points: WeatherPoint[]): WeatherPoint[] {
  if (points.length <= MAX_POINTS) return points;
  const out: WeatherPoint[] = [];
  for (let i = 0; i < MAX_POINTS; i++) out.push(points[Math.round((i * (points.length - 1)) / (MAX_POINTS - 1))]!);
  return out;
}

export async function buildWeatherSection(
  points: WeatherPoint[],
  fetchers: WeatherFetchers = defaultWeatherFetchers,
  now: Date = new Date(),
): Promise<WeatherSection> {
  const asOf = now.toISOString();
  const timed = points.filter((p) => p.etaAt !== null);
  if (timed.length === 0) {
    return { status: "unavailable", items: [], notes: ["Weather needs a timed plan (when you reach each stretch); this run could not be timed."], asOf };
  }
  const useCache = fetchers === defaultWeatherFetchers;
  const picked = sample(timed);
  const items: WeatherItem[] = [];
  let failed = 0;
  await Promise.all(
    picked.map(async (p) => {
      const cell = `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
      try {
        const [hourly, alerts] = await Promise.all([
          cached(`h:${cell}`, FORECAST_TTL_MS, now, () => fetchers.hourly(p.lat, p.lng), useCache),
          // Either call failing makes this spot "could not be checked" - an alert source that is down is never read as "no alerts".
          cached(`a:${cell}`, ALERT_TTL_MS, now, () => fetchers.alerts(p.lat, p.lng), useCache),
        ]);
        items.push(...weatherItemsForPoint(p.mile, new Date(p.etaAt as string), hourly, alerts));
      } catch {
        failed += 1;
      }
    }),
  );
  const notes: string[] = [
    `Checked ${picked.length - failed} of ${picked.length} spots along the route against the National Weather Service forecast for the time you'd be there.`,
  ];
  if (failed > 0) notes.push(`${failed} spot${failed === 1 ? "" : "s"} could not be checked (NWS unavailable or outside U.S. coverage) - no weather is claimed for those stretches.`);
  if (failed === picked.length) return { status: "unavailable", items: [], notes: ["Weather is unavailable right now - nothing is claimed about the route."], asOf };
  return { status: failed > 0 ? "partial" : "ok", items: mergeStretches(items), notes, asOf };
}
