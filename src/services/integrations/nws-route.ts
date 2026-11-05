// NWS point forecast + point alerts for Smart Path weather (docs/design/
// smart-path-intelligence.md §2.2). Free, keyless, official api.weather.gov with an
// honest User-Agent. Every response is Zod-validated and treated as untrusted data
// (text is shown, never obeyed); the hourly URL is followed only if it is on
// api.weather.gov. Failures throw plain errors; the caller turns them into
// "unavailable", never into a guess.

import { z } from "zod";

const HEADERS = { "User-Agent": "TruckingResearchEngine/1.0 (owner-operator route planning)", Accept: "application/geo+json" };
const TIMEOUT_MS = 12_000;

export interface HourlyPeriod {
  startTime: string;
  endTime: string;
  windMph: number | null;
  gustMph: number | null;
  shortForecast: string;
  precipChancePct: number | null;
  tempF: number | null;
}

export interface PointAlert {
  event: string;
  severity: string | null;
  headline: string | null;
  onset: string | null;
  ends: string | null;
}

const pointsSchema = z.object({ properties: z.object({ forecastHourly: z.string().url() }) });
const hourlySchema = z.object({
  properties: z.object({
    periods: z.array(
      z.object({
        startTime: z.string(),
        endTime: z.string(),
        temperature: z.number().nullable().optional(),
        temperatureUnit: z.string().optional(),
        windSpeed: z.string().nullable().optional(),
        windGust: z.string().nullable().optional(),
        shortForecast: z.string().optional(),
        probabilityOfPrecipitation: z.object({ value: z.number().nullable().optional() }).nullable().optional(),
      }),
    ),
  }),
});
const alertsSchema = z.object({
  features: z.array(
    z.object({
      properties: z.object({
        event: z.string(),
        severity: z.string().nullable().optional(),
        headline: z.string().nullable().optional(),
        onset: z.string().nullable().optional(),
        ends: z.string().nullable().optional(),
        expires: z.string().nullable().optional(),
      }),
    }),
  ),
});

/** "10 to 20 mph" -> 20; "15 mph" -> 15; anything unreadable -> null. */
export function maxMph(text: string | null | undefined): number | null {
  if (!text) return null;
  const nums = [...text.matchAll(/\d+/g)].map((m) => Number(m[0]));
  return nums.length > 0 ? Math.max(...nums) : null;
}

export function parseHourly(json: unknown): HourlyPeriod[] {
  const parsed = hourlySchema.safeParse(json);
  if (!parsed.success) throw new Error("NWS hourly forecast didn't match the expected shape.");
  return parsed.data.properties.periods.map((p) => ({
    startTime: p.startTime,
    endTime: p.endTime,
    windMph: maxMph(p.windSpeed),
    gustMph: maxMph(p.windGust),
    shortForecast: p.shortForecast ?? "",
    precipChancePct: p.probabilityOfPrecipitation?.value ?? null,
    tempF: p.temperatureUnit === "F" || !p.temperatureUnit ? (p.temperature ?? null) : null,
  }));
}

export function parseAlerts(json: unknown): PointAlert[] {
  const parsed = alertsSchema.safeParse(json);
  if (!parsed.success) throw new Error("NWS alerts didn't match the expected shape.");
  return parsed.data.features.map((f) => ({
    event: f.properties.event,
    severity: f.properties.severity ?? null,
    headline: f.properties.headline ?? null,
    onset: f.properties.onset ?? null,
    ends: f.properties.ends ?? f.properties.expires ?? null,
  }));
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`NWS request failed: ${res.status} ${res.statusText}`);
  return res.json();
}

/** Hourly forecast for a point (NWS grid lookup, then the hourly URL it names). */
export async function fetchHourlyForecast(lat: number, lng: number): Promise<HourlyPeriod[]> {
  const points = pointsSchema.safeParse(await getJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`));
  if (!points.success) throw new Error("NWS grid lookup didn't match the expected shape.");
  const url = points.data.properties.forecastHourly;
  if (!url.startsWith("https://api.weather.gov/")) throw new Error("NWS named a forecast URL outside api.weather.gov; ignored.");
  return parseHourly(await getJson(url));
}

export async function fetchPointAlerts(lat: number, lng: number): Promise<PointAlert[]> {
  return parseAlerts(await getJson(`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lng.toFixed(4)}&status=actual`));
}
