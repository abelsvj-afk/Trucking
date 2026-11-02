// Deep Research Engine watcher: weather / disruption (2026-11-02
// design, D-3). Nationally, only the big shapes signal - hurricane-
// class events and warning-class storms spanning multiple states.
// The precise work (is it on HIS corridor?) happens in the trigger
// layer via data.states + corridor escalation (D-5) and in delivery
// classification (D-6). One signal per event type per day, states
// unioned across that event's alerts.

import { fetchActiveAlerts, type NwsAlert } from "@/services/integrations/nws";
import type { PressureSignal, Watcher, WatcherResult } from "./types";

export const NWS_WATCHER_KEY = "nws_weather";

const WARNING_EVENTS = [
  "Hurricane Warning",
  "Hurricane Watch",
  "Tropical Storm Warning",
  "Winter Storm Warning",
  "Blizzard Warning",
  "Ice Storm Warning",
  "Tornado Warning",
  "Flash Flood Warning",
  "Flood Warning",
  "Extreme Wind Warning",
  "Storm Surge Warning",
];

/** Severity rank the delivery layer reads: 4+ = urgent-capable (warning class, multi-state or hurricane). */
export function severityRank(event: string, stateCount: number): number {
  if (event.includes("Hurricane") || event.includes("Storm Surge")) return 5;
  if (stateCount >= 3) return 4;
  if (stateCount >= 2) return 3;
  return 2;
}

/** Builds national weather signals from active alerts. Pure - unit-tested. */
export function buildWeatherSignals(alerts: NwsAlert[], observedAt: string): PressureSignal[] {
  const byEvent = new Map<string, { states: Set<string>; headlines: string[] }>();
  for (const alert of alerts) {
    if (!WARNING_EVENTS.includes(alert.event)) continue;
    const entry = byEvent.get(alert.event) ?? { states: new Set<string>(), headlines: [] };
    for (const s of alert.states) entry.states.add(s);
    if (alert.headline && entry.headlines.length < 3) entry.headlines.push(alert.headline);
    byEvent.set(alert.event, entry);
  }

  const day = observedAt.slice(0, 10);
  const signals: PressureSignal[] = [];
  for (const [event, entry] of byEvent) {
    const states = [...entry.states];
    const rank = severityRank(event, states.length);
    // National floor (design D-3): multi-state or hurricane-class only.
    if (rank < 4) continue;
    signals.push({
      watcherKey: NWS_WATCHER_KEY,
      kind: "weather_alert",
      topic: "weather",
      magnitude: rank >= 5 ? 1 : 0.85,
      summary: `${event} active across ${states.length} states (${states.join(", ")}). ${entry.headlines[0] ?? ""}`.trim(),
      items: entry.headlines.map((headline) => ({
        title: headline,
        url: "https://www.weather.gov/",
        publishedAt: day,
        summary: event,
      })),
      data: { states, severityRank: rank, event },
      dedupeKey: `nws_weather:${event.replace(/\s+/g, "_").toLowerCase()}:${day}`,
      observedAt,
    });
  }
  return signals;
}

export const nwsWeatherWatcher: Watcher = {
  key: NWS_WATCHER_KEY,
  async poll(): Promise<WatcherResult> {
    try {
      const alerts = await fetchActiveAlerts();
      const signals = buildWeatherSignals(alerts, new Date().toISOString());
      return {
        watcherKey: NWS_WATCHER_KEY,
        status: "ok",
        message: null,
        signals,
        state: { lastAlertCount: alerts.length },
      };
    } catch (err) {
      return {
        watcherKey: NWS_WATCHER_KEY,
        status: "error",
        message: err instanceof Error ? err.message : "Unknown error polling NWS.",
        signals: [],
        state: {},
      };
    }
  },
};
