// Smart Path intelligence, Phase 2b (docs/design/smart-path-intelligence.md §2.2):
// turns the forecast and alerts at a route point into plain warnings AT THE TIME HE
// WILL BE THERE. Pure. Thresholds are named constants (and shown to the owner);
// these are advisory lines - they never decide the verdict's legality.

import type { HourlyPeriod, PointAlert } from "@/services/integrations/nws-route";

/** Sustained wind that matters for a high-profile trailer (owner may lower it; spec open question 3). */
export const WIND_WARN_MPH = 35;
export const GUST_WARN_MPH = 45;
export const HEAT_WARN_F = 100;
export const COLD_WARN_F = 15;

/** NWS events worth a line to a truck driver; matched on the event name, case-insensitively. */
const ALERT_PATTERN = /(winter storm|blizzard|ice storm|freezing rain|high wind|wind advisory|dense fog|flood|tornado|severe thunderstorm|dust storm|snow squall|hurricane|tropical storm|extreme heat|excessive heat|extreme cold|wind chill)/i;

export type WeatherKind = "alert" | "wind" | "ice" | "precip" | "heat" | "cold" | "fog";

export interface WeatherItem {
  mile: number;
  etaAt: string;
  kind: WeatherKind;
  severe: boolean;
  text: string;
  source: "NWS";
}

const covers = (startIso: string | null, endIso: string | null, whenMs: number): boolean => {
  const start = startIso ? Date.parse(startIso) : Number.NEGATIVE_INFINITY;
  const end = endIso ? Date.parse(endIso) : Number.POSITIVE_INFINITY;
  return (Number.isNaN(start) || start <= whenMs) && (Number.isNaN(end) || whenMs <= end);
};

/** Items for ONE point at the time he arrives there. An alert that ends before, or starts after, his arrival is not his weather. */
export function weatherItemsForPoint(
  mile: number,
  eta: Date,
  hourly: HourlyPeriod[],
  alerts: PointAlert[],
): WeatherItem[] {
  const etaMs = eta.getTime();
  const etaAt = eta.toISOString();
  const items: WeatherItem[] = [];

  for (const a of alerts) {
    if (!ALERT_PATTERN.test(a.event)) continue;
    if (!covers(a.onset, a.ends, etaMs)) continue;
    items.push({
      mile, etaAt, kind: "alert", source: "NWS",
      severe: a.severity === "Severe" || a.severity === "Extreme",
      text: `${a.event}${a.headline ? ` - ${a.headline}` : ""}`,
    });
  }

  const period = hourly.find((p) => covers(p.startTime, p.endTime, etaMs));
  if (period) {
    const wind = Math.max(period.windMph ?? 0, 0);
    const gust = Math.max(period.gustMph ?? 0, 0);
    if (wind >= WIND_WARN_MPH || gust >= GUST_WARN_MPH) {
      items.push({
        mile, etaAt, kind: "wind", source: "NWS", severe: wind >= WIND_WARN_MPH + 10,
        text: `Wind forecast ${wind} mph${gust ? `, gusts to ${gust} mph` : ""} when you get here - hard on an empty or high-sided trailer.`,
      });
    }
    const sf = period.shortForecast;
    if (/(freezing rain|ice|sleet|freezing drizzle|wintry mix|snow)/i.test(sf)) {
      items.push({ mile, etaAt, kind: "ice", source: "NWS", severe: /(freezing rain|ice|sleet)/i.test(sf), text: `Forecast: ${sf}.` });
    } else if (/(thunderstorm|heavy rain|showers)/i.test(sf) && (period.precipChancePct ?? 0) >= 60) {
      items.push({ mile, etaAt, kind: "precip", source: "NWS", severe: false, text: `Forecast: ${sf} (${period.precipChancePct}% chance).` });
    }
    if (/fog/i.test(sf)) items.push({ mile, etaAt, kind: "fog", source: "NWS", severe: /dense/i.test(sf), text: `Forecast: ${sf}.` });
    if (period.tempF !== null && period.tempF >= HEAT_WARN_F) items.push({ mile, etaAt, kind: "heat", source: "NWS", severe: false, text: `${period.tempF}°F forecast - watch tires and coolant.` });
    if (period.tempF !== null && period.tempF <= COLD_WARN_F) items.push({ mile, etaAt, kind: "cold", source: "NWS", severe: false, text: `${period.tempF}°F forecast - fuel gelling and air-line freeze risk.` });
  }
  return items;
}

/** Same warning at neighboring points is one stretch: merge consecutive duplicates (same kind and text). */
export function mergeStretches(items: WeatherItem[]): (WeatherItem & { endMile: number })[] {
  const out: (WeatherItem & { endMile: number })[] = [];
  for (const it of [...items].sort((a, b) => a.mile - b.mile)) {
    const last = out.find((o) => o.kind === it.kind && o.text === it.text && it.mile - o.endMile <= 60);
    if (last) last.endMile = it.mile;
    else out.push({ ...it, endMile: it.mile });
  }
  return out.sort((a, b) => a.mile - b.mile);
}
