// Smart Path live awareness (owner 2026-11-17): live traffic delays
// on the route, mapped to route miles, colored by severity, with the
// ahead-of-time call — reroute around it, or stay because it clears.
// Pure: no fetching, no numbers invented — every figure comes from
// the traffic provider (TomTom) or the plan's own timing.
//
// Severity (TomTom magnitudeOfDelay 0 unknown / 1 minor / 2 moderate /
// 3 major / 4 severe, plus the reported delay in seconds):
//   severe (red)    = magnitude >= 3, or delay >= 25 min
//   moderate (orange) = magnitude 2, or delay >= 10 min
//   minor           = everything else — listed, never colored.
// An uncolored stretch means "no reported incident", never "clear".

import {
  distanceToRouteMiles,
  haversineMiles,
  pointAlongRoute,
  routeFractionOfPoint,
  type LatLng,
} from "./smart-path";

export const NEAR_ROUTE_MILES = 5;

export const SEVERE_COLOR = "#dc2626";
export const MODERATE_COLOR = "#ea580c";

/** One incident as the provider reported it, before route mapping. */
export interface TrafficIncident {
  id: string;
  /** TomTom iconCategory: 1 accident, 6 jam, 7 lane closed, 8 road closed, 9 road works, 14 broken-down vehicle, 0 unknown. */
  iconCategory: number;
  description: string;
  /** Geometry points of the incident (Point = one, LineString = several), [lng, lat] order already converted. */
  points: LatLng[];
  /** Reported delay in seconds; null when the provider does not state one. */
  delaySeconds: number | null;
  /** TomTom magnitudeOfDelay 0-4 (0 = unknown). */
  magnitude: number;
  startTime: string | null;
  endTime: string | null;
  from: string | null;
  to: string | null;
  lengthMeters: number | null;
  roadNumbers: string[];
}

export type TrafficSeverity = "severe" | "moderate" | "minor";

export interface TrafficItem {
  id: string;
  /** Route mile where the affected stretch starts. */
  mile: number;
  /** Route mile where it ends. */
  endMile: number;
  /** When he reaches the start of it, from the plan's corridor timing; null when the run cannot be timed. */
  etaAt: string | null;
  category: string;
  severity: TrafficSeverity;
  /** Segment color for the map; null when minor (listed only, never colored). */
  color: string | null;
  /** Reported delay in whole minutes; null when the provider does not state one. */
  delayMinutes: number | null;
  text: string;
  startsAt: string | null;
  endsAt: string | null;
  from: string | null;
  to: string | null;
  roadNumbers: string[];
}

const CATEGORY_WORDS: Record<number, string> = {
  1: "Accident",
  2: "Fog",
  3: "Dangerous conditions",
  4: "Rain",
  5: "Ice",
  6: "Traffic jam",
  7: "Lane closed",
  8: "Road closed",
  9: "Road work",
  10: "Wind",
  11: "Flooding",
  14: "Broken-down vehicle",
};

export function categoryWord(iconCategory: number): string {
  return CATEGORY_WORDS[iconCategory] ?? "Delay";
}

export function severityOf(magnitude: number, delayMinutes: number | null): TrafficSeverity {
  if (magnitude >= 3 || (delayMinutes !== null && delayMinutes >= 25)) return "severe";
  if (magnitude === 2 || (delayMinutes !== null && delayMinutes >= 10)) return "moderate";
  return "minor";
}

function colorOf(severity: TrafficSeverity): string | null {
  return severity === "severe" ? SEVERE_COLOR : severity === "moderate" ? MODERATE_COLOR : null;
}

/**
 * Corridor timing for ETA lookup: the corridor points the route
 * check already computed (mile + the time he reaches it).
 */
export interface CorridorTiming {
  mile: number;
  etaAt: string | null;
}

function etaAtMile(timing: CorridorTiming[], mile: number): string | null {
  if (timing.length === 0) return null;
  let before: CorridorTiming | null = null;
  let after: CorridorTiming | null = null;
  for (const pt of timing) {
    if (pt.mile <= mile) before = pt;
    if (pt.mile >= mile && after === null) after = pt;
  }
  const pick = after ?? before;
  return pick?.etaAt ?? null;
}

/**
 * Maps provider incidents onto the route. An incident whose nearest
 * point is farther than NEAR_ROUTE_MILES from the line is not his
 * traffic. Returns items sorted by mile. Never throws on a weird
 * incident — it is skipped, not guessed at.
 */
export function mapIncidentsToRoute(
  incidents: TrafficIncident[],
  geometry: LatLng[],
  timing: CorridorTiming[],
): TrafficItem[] {
  if (geometry.length < 2) return [];
  let totalMiles = 0;
  for (let i = 1; i < geometry.length; i++) totalMiles += haversineMiles(geometry[i - 1]!, geometry[i]!);
  if (totalMiles <= 0) return [];

  const items: TrafficItem[] = [];
  for (const inc of incidents) {
    if (inc.points.length === 0) continue;
    // Nearest route distance over the incident's points; skip when it is not on his route.
    let nearest = Number.POSITIVE_INFINITY;
    for (const p of inc.points) {
      const d = distanceToRouteMiles(p, geometry);
      if (d < nearest) nearest = d;
    }
    if (!(nearest <= NEAR_ROUTE_MILES)) continue;

    const fractions = inc.points.map((p) => routeFractionOfPoint(p, geometry));
    const fromMile = Math.min(...fractions) * totalMiles;
    const toMile = Math.max(...fractions) * totalMiles;
    const delayMinutes = inc.delaySeconds !== null ? Math.round(inc.delaySeconds / 60) : null;
    const severity = severityOf(inc.magnitude, delayMinutes);
    const category = categoryWord(inc.iconCategory);
    const road = inc.roadNumbers.length > 0 ? ` on ${inc.roadNumbers.join(", ")}` : "";
    const stretch = toMile - fromMile > 0.5 ? `, mile ${Math.round(fromMile)}–${Math.round(toMile)}` : `, mile ${Math.round(fromMile)}`;
    items.push({
      id: inc.id,
      mile: Math.round(fromMile * 10) / 10,
      endMile: Math.round(toMile * 10) / 10,
      etaAt: etaAtMile(timing, fromMile),
      category,
      severity,
      color: colorOf(severity),
      delayMinutes,
      text:
        `${category}${road}${stretch}` +
        `${inc.description ? ` — ${inc.description}` : ""}` +
        `${delayMinutes !== null ? ` — about ${delayMinutes} min delay` : ""}.`,
      startsAt: inc.startTime,
      endsAt: inc.endTime,
      from: inc.from,
      to: inc.to,
      roadNumbers: inc.roadNumbers,
    });
  }
  return items.sort((a, b) => a.mile - b.mile);
}

/** Colored stretches for the map: merged same-color runs, in mile order. */
export interface TrafficSegment {
  fromMile: number;
  toMile: number;
  color: string;
}

export function trafficSegments(items: TrafficItem[]): TrafficSegment[] {
  const colored = items.filter((i) => i.color !== null).sort((a, b) => a.mile - b.mile);
  const out: TrafficSegment[] = [];
  for (const it of colored) {
    const last = out[out.length - 1];
    if (last && last.color === it.color && it.mile - last.toMile <= 2) {
      last.toMile = Math.max(last.toMile, it.endMile);
    } else {
      out.push({ fromMile: it.mile, toMile: Math.max(it.endMile, it.mile), color: it.color! });
    }
  }
  return out;
}

/** Avoid circles for a truck-checked detour around the colored delays. */
export interface AvoidCircle {
  lat: number;
  lng: number;
  radiusMiles: number;
}

export function avoidCirclesFor(
  items: TrafficItem[],
  geometry: LatLng[],
  totalMiles: number,
): AvoidCircle[] {
  const out: AvoidCircle[] = [];
  for (const it of items.filter((i) => i.color !== null)) {
    const midMile = (it.mile + it.endMile) / 2;
    const point = pointAlongRoute(geometry, totalMiles > 0 ? midMile / totalMiles : 0);
    if (!point) continue;
    const half = (it.endMile - it.mile) / 2;
    out.push({ lat: point.lat, lng: point.lng, radiusMiles: Math.max(3, Math.round((half + 2) * 10) / 10) });
    if (out.length >= 5) break;
  }
  return out;
}

/** The worst delay ahead: the non-minor item with the longest reported delay, or null. */
export function worstDelayAhead(items: TrafficItem[]): TrafficItem | null {
  return (
    [...items]
      .filter((i) => i.severity !== "minor")
      .sort((a, b) => (b.delayMinutes ?? 0) - (a.delayMinutes ?? 0))[0] ?? null
  );
}

export interface TrafficCall {
  decision: "reroute" | "stay" | "none";
  /** The worst delay ahead, in whole minutes; null when no delay ahead carries a reported delay. */
  delayMinutes: number | null;
  /** Minutes the detour saves over staying, when a detour was compared; null when none was. */
  savesMinutes: number | null;
  /** When the delay clears, when the provider states an end; null otherwise. */
  clearsAt: string | null;
  /** Plain-words reasoning — always shown next to the decision. */
  reason: string;
  /** The incident this call is about; null when there is nothing ahead. */
  incidentId: string | null;
}

/** Minutes a detour must save before the app says "reroute". */
export const REROUTE_MIN_SAVINGS_MIN = 10;

export interface TrafficCallInput {
  /** Items ahead of him (mile >= his current mile), nearest first. */
  itemsAhead: TrafficItem[];
  /** His current route mile; null when unknown (the call cannot judge "ahead"). */
  currentMile: number | null;
  /** When he reaches the incident's start, from the plan/live timing; null when untimed. */
  etaAtIncident: string | null;
  /** Truck-checked detour for the remaining run, when one was computed; null when none was (or none could be). */
  detour: { durationMinutes: number; distanceMiles: number } | null;
  /** Planned remaining drive minutes on the current route, without the delay. */
  plannedRemainingMinutes: number | null;
  now: Date;
}

/**
 * The ahead-of-time call for the worst delay ahead. Rules, in order:
 * 1. Nothing ahead -> none. 2. It clears before he gets there ->
 * stay. 3. A truck-checked detour saves >= 10 min -> reroute.
 * 4. Otherwise stay, with the reason (minor delay / detour saves
 * too little / no detour to compare). Never invents a detour.
 */
export function evaluateTrafficCall(input: TrafficCallInput): TrafficCall {
  const worst = worstDelayAhead(input.itemsAhead);
  if (!worst) {
    return {
      decision: "none",
      delayMinutes: null,
      savesMinutes: null,
      clearsAt: null,
      reason: "No reported delay ahead on your route.",
      incidentId: null,
    };
  }
  const delay = worst.delayMinutes;
  if (worst.endsAt && input.etaAtIncident) {
    const endsMs = Date.parse(worst.endsAt);
    const etaMs = Date.parse(input.etaAtIncident);
    if (Number.isFinite(endsMs) && Number.isFinite(etaMs) && endsMs <= etaMs) {
      return {
        decision: "stay",
        delayMinutes: delay,
        savesMinutes: null,
        clearsAt: worst.endsAt,
        reason:
          `Stay on this route — the ${worst.category.toLowerCase()} at mile ${Math.round(worst.mile)} ` +
          `is reported to clear before you get there${delay !== null ? ` (about ${delay} min delay if it doesn't)` : ""}.`,
        incidentId: worst.id,
      };
    }
  }
  if (input.detour && input.plannedRemainingMinutes !== null && delay !== null) {
    const staying = input.plannedRemainingMinutes + delay;
    const saves = Math.round(staying - input.detour.durationMinutes);
    if (saves >= REROUTE_MIN_SAVINGS_MIN) {
      return {
        decision: "reroute",
        delayMinutes: delay,
        savesMinutes: saves,
        clearsAt: worst.endsAt,
        reason:
          `Reroute around it — the ${worst.category.toLowerCase()} at mile ${Math.round(worst.mile)} ` +
          `costs about ${delay} min, and the truck-checked detour saves about ${saves} min.`,
        incidentId: worst.id,
      };
    }
    return {
      decision: "stay",
      delayMinutes: delay,
      savesMinutes: saves,
      clearsAt: worst.endsAt,
      reason:
        `Stay on this route — the ${worst.category.toLowerCase()} at mile ${Math.round(worst.mile)} ` +
        `costs about ${delay} min, and the detour only saves about ${Math.max(0, saves)} min. Not worth the swing.`,
      incidentId: worst.id,
    };
  }
  if (delay !== null && delay < REROUTE_MIN_SAVINGS_MIN) {
    return {
      decision: "stay",
      delayMinutes: delay,
      savesMinutes: null,
      clearsAt: worst.endsAt,
      reason:
        `Stay on this route — the ${worst.category.toLowerCase()} at mile ${Math.round(worst.mile)} ` +
        `is only about ${delay} min. Not worth rerouting.`,
      incidentId: worst.id,
    };
  }
  return {
    decision: "stay",
    delayMinutes: delay,
    savesMinutes: null,
    clearsAt: worst.endsAt,
    reason:
      `Stay on this route — the ${worst.category.toLowerCase()} at mile ${Math.round(worst.mile)}` +
      `${delay !== null ? ` costs about ${delay} min` : ""}, and no truck-checked detour could be compared, so there is nothing better to take.`,
    incidentId: worst.id,
  };
}
