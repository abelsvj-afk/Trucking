// Smart Path live awareness (owner 2026-11-17): the traffic
// section of a route check. Asks TomTom for reported incidents on
// the corridor, maps them to route miles, colors the affected
// stretches, and makes the ahead-of-time call. Never throws —
// failure degrades the section to "unavailable", never to
// fabricated traffic.

import { haversineMiles, type LatLng } from "@/lib/smart-path";
import {
  evaluateTrafficCall,
  mapIncidentsToRoute,
  trafficSegments,
  worstDelayAhead,
  type TrafficCall,
  type TrafficIncident,
  type TrafficItem,
  type TrafficSegment,
} from "@/lib/smart-path-traffic";
import {
  fetchTomTomIncidents,
  isTomTomConfigured,
} from "@/services/integrations/tomtom-traffic";

export interface TrafficFetchers {
  incidents: (points: LatLng[]) => Promise<TrafficIncident[]>;
}

export const defaultTrafficFetchers: TrafficFetchers = {
  incidents: (points) =>
    fetchTomTomIncidents({ apiKey: process.env.TOMTOM_API_KEY ?? "", points }),
};

export interface TrafficSection {
  status: "ok" | "unavailable";
  items: TrafficItem[];
  segments: TrafficSegment[];
  call: TrafficCall;
  notes: string[];
  asOf: string;
}

export interface TrafficCorridorPoint {
  mile: number;
  etaAt: string | null;
}

/**
 * Live poll ahead window (owner 2026-11-17): while driving, traffic is
 * polled only about an hour ahead — never the whole remaining run. The
 * cut is by the corridor's planned ETAs (the poll's corridor timing is
 * relative to his current position, so mile 0 is now); when the corridor
 * carries no usable ETA, the fallback is ~100 route miles. The pre-trip
 * route check does NOT use this — it still asks TomTom about the whole
 * route. Pure.
 */
export const LIVE_TRAFFIC_AHEAD_MINUTES = 60;
export const LIVE_TRAFFIC_AHEAD_MILES = 100;

export function truncateToAheadWindow(input: {
  geometry: LatLng[];
  corridor: TrafficCorridorPoint[];
  totalMiles: number;
  now?: Date;
}): { geometry: LatLng[]; corridor: TrafficCorridorPoint[]; totalMiles: number } {
  const { geometry, corridor, totalMiles } = input;
  if (geometry.length < 2 || totalMiles <= 0) return { geometry, corridor, totalMiles };
  const nowMs = (input.now ?? new Date()).getTime();
  const cutoffMs = nowMs + LIVE_TRAFFIC_AHEAD_MINUTES * 60_000;
  let cutMile: number | null = null;
  for (const pt of corridor) {
    if (pt.etaAt === null) continue;
    const etaMs = Date.parse(pt.etaAt);
    if (Number.isFinite(etaMs) && etaMs <= cutoffMs) cutMile = Math.max(cutMile ?? 0, pt.mile);
  }
  if (cutMile === null || cutMile <= 0) cutMile = LIVE_TRAFFIC_AHEAD_MILES;
  if (cutMile >= totalMiles) return { geometry, corridor, totalMiles };
  const ahead: LatLng[] = [geometry[0]!];
  let walked = 0;
  for (let i = 1; i < geometry.length; i++) {
    const step = haversineMiles(geometry[i - 1]!, geometry[i]!);
    if (walked + step > cutMile && ahead.length > 1) break;
    ahead.push(geometry[i]!);
    walked += step;
  }
  if (ahead.length < 2) return { geometry, corridor, totalMiles };
  return {
    geometry: ahead,
    corridor: corridor.filter((pt) => pt.mile <= cutMile),
    totalMiles: Math.round(walked * 10) / 10,
  };
}

export interface BuildTrafficSectionInput {
  geometry: LatLng[];
  totalMiles: number;
  /** Corridor timing for ETA lookup (mile + the time he reaches it). */
  corridor: TrafficCorridorPoint[];
  /** His current route mile, when known (drive mode); null at plan time. */
  currentMile?: number | null;
  /** Truck-checked detour for the remaining run, when one was compared. */
  detour?: { durationMinutes: number; distanceMiles: number } | null;
  /** Planned remaining drive minutes on the current route, without the delay. */
  plannedRemainingMinutes?: number | null;
  fetchers?: TrafficFetchers;
  isConfigured?: () => boolean;
  now?: Date;
}

export async function buildTrafficSection(input: BuildTrafficSectionInput): Promise<TrafficSection> {
  const now = input.now ?? new Date();
  const asOf = now.toISOString();
  const fetchers = input.fetchers ?? defaultTrafficFetchers;
  // Custom fetchers own their config (same seam pattern as the
  // weather cache); the default fetcher needs the TomTom key.
  const configured = input.isConfigured ?? (input.fetchers ? () => true : isTomTomConfigured);
  if (!configured()) {
    return {
      status: "unavailable",
      items: [],
      segments: [],
      call: {
        decision: "none",
        delayMinutes: null,
        savesMinutes: null,
        clearsAt: null,
        reason: "Live traffic isn't set up yet, so no call can be made.",
        incidentId: null,
      },
      notes: [
        "Live traffic isn't set up yet — the app needs a free TomTom key (TOMTOM_API_KEY) before it can show delays. Nothing is claimed about traffic on this route.",
      ],
      asOf,
    };
  }
  let incidents: TrafficIncident[];
  try {
    incidents = await fetchers.incidents(input.geometry);
  } catch {
    return {
      status: "unavailable",
      items: [],
      segments: [],
      call: {
        decision: "none",
        delayMinutes: null,
        savesMinutes: null,
        clearsAt: null,
        reason: "Live traffic couldn't be reached, so no call can be made.",
        incidentId: null,
      },
      notes: ["Live traffic couldn't be reached right now — nothing is claimed about delays on this route."],
      asOf,
    };
  }
  const items = mapIncidentsToRoute(incidents, input.geometry, input.corridor);
  const segments = trafficSegments(items);
  const currentMile = input.currentMile ?? null;
  const itemsAhead = items.filter((i) => currentMile === null || i.mile >= currentMile);
  const worst = worstDelayAhead(itemsAhead);
  const call = evaluateTrafficCall({
    itemsAhead,
    currentMile,
    etaAtIncident: worst?.etaAt ?? null,
    detour: input.detour ?? null,
    plannedRemainingMinutes: input.plannedRemainingMinutes ?? null,
    now,
  });
  const notes = [
    items.length === 0
      ? "Checked live traffic (TomTom) — no reported delays on your route."
      : `Checked live traffic (TomTom) — ${items.length} reported ${items.length === 1 ? "delay" : "delays"} on your route.`,
    "A stretch with no color means no reported incident — not a clear road. TomTom knows reported incidents, not every slowdown.",
  ];
  return { status: "ok", items, segments, call, notes, asOf };
}
