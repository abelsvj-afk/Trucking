// Smart Path live awareness (owner 2026-11-17): the traffic
// section of a route check. Asks TomTom for reported incidents on
// the corridor, maps them to route miles, colors the affected
// stretches, and makes the ahead-of-time call. Never throws —
// failure degrades the section to "unavailable", never to
// fabricated traffic.

import type { LatLng } from "@/lib/smart-path";
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
