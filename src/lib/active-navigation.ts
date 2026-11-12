// Guidance decisions for the everyday map (active-load navigation, points 3-5). Pure - every rule here is testable without a map.
//  - U-TURNS: a route "needs a U-turn" when the engine labels one, or when it starts by heading back the way the truck is travelling.
//    While trailering such a route is REFUSED (the old line stays; he keeps going and it tries again from further on). Bobtail may take it.
//  - ADOPTION: only a truck-legal route may be guided on. A car-profile route may be drawn but never guided on, and never replaces a
//    truck-legal line already on screen.
//  - LIVE PROGRESS: miles left and ETA come from where the truck is along the line; the ETA scales the engine's own drive time by the
//    share of the route still ahead - no speed is assumed or invented.
//  - HOS: the ETA is compared with the driver's REAL remaining clocks. Display only; no hours math is changed here.

import { haversineMiles, type LatLng } from "@/lib/smart-path";
import { formatClock, HOME_TIME_ZONE } from "@/lib/display-zone";
import { routeProgress } from "@/lib/route-progress";

export interface NavManeuver {
  instruction: string;
  distanceMiles: number;
  atFraction: number;
}

export interface NavRoute {
  distanceMiles: number;
  durationMinutes: number;
  truckLegal: boolean;
  guidanceAllowed: boolean;
  notTruckLegalNotice: string | null;
  providerName: string;
  geometry: LatLng[];
  maneuvers: NavManeuver[];
}

/** The engine's own words for a reversal. */
export const isUTurnInstruction = (instruction: string): boolean => /\bu[\s-]?turn\b|\bturn around\b|\bmake a u\b|\breverse direction\b/i.test(instruction);

const toRad = (d: number) => (d * Math.PI) / 180;
/** Initial compass bearing from a to b, 0-360. */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (Math.atan2(y, x) * 180) / Math.PI + (Math.atan2(y, x) < 0 ? 360 : 0);
}
export const headingDifference = (a: number, b: number): number => {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
};

/** A heading only means something while the truck is actually moving. */
export const MIN_HEADING_SPEED_MPH = 8;
/** The route's first stretch pointing more than this away from the direction of travel = it starts with a reversal. */
export const REVERSAL_DEGREES = 135;
/** How far along the line to look for its starting direction. */
const START_LOOKAHEAD_MILES = 0.15;

/** True when the line begins by going back the way the truck is travelling (an unlabelled U-turn). Unknown heading/slow = cannot tell = false. */
export function startsWithReversal(geometry: LatLng[], headingDeg: number | null, speedMph: number | null): boolean {
  if (headingDeg === null || !Number.isFinite(headingDeg) || speedMph === null || speedMph < MIN_HEADING_SPEED_MPH || geometry.length < 2) return false;
  let walked = 0;
  let end = geometry[1]!;
  for (let i = 1; i < geometry.length; i++) {
    walked += haversineMiles(geometry[i - 1]!, geometry[i]!);
    end = geometry[i]!;
    if (walked >= START_LOOKAHEAD_MILES) break;
  }
  if (walked < 0.02) return false; // too short to have a direction
  return headingDifference(bearingDeg(geometry[0]!, end), headingDeg) > REVERSAL_DEGREES;
}

export interface UTurnCheck {
  needsUTurn: boolean;
  /** Which evidence said so. */
  why: "labelled" | "starts-behind" | null;
}

export function checkUTurn(route: Pick<NavRoute, "geometry" | "maneuvers">, headingDeg: number | null, speedMph: number | null): UTurnCheck {
  if (route.maneuvers.some((m) => isUTurnInstruction(m.instruction))) return { needsUTurn: true, why: "labelled" };
  if (startsWithReversal(route.geometry, headingDeg, speedMph)) return { needsUTurn: true, why: "starts-behind" };
  return { needsUTurn: false, why: null };
}

export type AdoptDecision =
  | { adopt: true; guide: boolean; notice: string | null }
  | { adopt: false; reason: "u-turn-with-trailer" | "car-route-would-replace-truck-route" | "no-geometry"; notice: string };

export const NAV_COPY = {
  uTurnRefused: "A new route needed a U-turn - not with a trailer on. Keep going; I'll route again from further on.",
  uTurnRefusedNoLine: "The only route from here starts with a U-turn - not with a trailer on. Keep going the way you're headed and I'll route again.",
  carKept: "I could only get a car route from here, so I'm keeping your truck route. Use the truck's own navigation until you're back on the line.",
  offRoute: "Off the route - getting a new one from where you are.",
  rerouted: "New truck route from where you are.",
} as const;

/**
 * May `incoming` become the line on the map, and may guidance run on it?
 * `current` is the route already on screen (null = none). `trailering` is the owner's rule: the active load has a trailer.
 */
export function decideAdoption(input: {
  incoming: NavRoute;
  current: NavRoute | null;
  trailering: boolean;
  headingDeg: number | null;
  speedMph: number | null;
}): AdoptDecision {
  const { incoming, current, trailering } = input;
  if (incoming.geometry.length < 2) return { adopt: false, reason: "no-geometry", notice: "I couldn't get a route just now." };
  if (trailering && checkUTurn(incoming, input.headingDeg, input.speedMph).needsUTurn) {
    return { adopt: false, reason: "u-turn-with-trailer", notice: current ? NAV_COPY.uTurnRefused : NAV_COPY.uTurnRefusedNoLine };
  }
  if (!incoming.truckLegal) {
    // A car route never replaces a truck-legal line; with nothing on screen it may be DRAWN, stamped, with guidance off.
    if (current?.truckLegal) return { adopt: false, reason: "car-route-would-replace-truck-route", notice: NAV_COPY.carKept };
    return { adopt: true, guide: false, notice: incoming.notTruckLegalNotice };
  }
  return { adopt: true, guide: incoming.guidanceAllowed, notice: null };
}

export interface LiveGuidance {
  onRoute: boolean;
  milesLeft: number | null;
  minutesLeft: number | null;
  /** ISO instant; show it in Eastern time. */
  etaAt: string | null;
  /** The next turn and how far it is, when guidance is allowed and he is on the line. */
  next: { instruction: string; inMiles: number } | null;
  /** The turns still ahead (first is `next`). */
  ahead: { instruction: string; inMiles: number }[];
  traveled: LatLng[];
  offRouteMiles: number | null;
}

export function liveGuidance(route: NavRoute, position: LatLng, nowMs: number, guide: boolean): LiveGuidance {
  const progress = routeProgress(position, route.geometry);
  if (!progress || !progress.onRoute || progress.fraction === null || progress.milesLeft === null) {
    return { onRoute: false, milesLeft: null, minutesLeft: null, etaAt: null, next: null, ahead: [], traveled: [], offRouteMiles: progress?.offRouteMiles ?? null };
  }
  // The line's own length can differ slightly from the engine's distance; scale both to the engine's figures.
  const share = 1 - progress.fraction;
  const milesLeft = Math.max(0, route.distanceMiles * share);
  const minutesLeft = Math.max(0, route.durationMinutes * share);
  const ahead = guide
    ? route.maneuvers
        .filter((m) => m.atFraction >= progress.fraction! - 0.0005)
        .map((m) => ({ instruction: m.instruction, inMiles: Math.max(0, (m.atFraction - progress.fraction!) * route.distanceMiles) }))
    : [];
  return {
    onRoute: true,
    milesLeft,
    minutesLeft,
    etaAt: new Date(nowMs + minutesLeft * 60_000).toISOString(),
    next: ahead[0] ?? null,
    ahead,
    traveled: progress.traveled,
    offRouteMiles: progress.offRouteMiles,
  };
}

const span = (minutes: number) => {
  const m = Math.max(1, Math.round(minutes));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};

export interface ClockInput {
  /** Remaining 11-hour driving time, ms; null = not known. */
  driveLeftMs: number | null;
  /** Remaining 14-hour window, ms; null = not known. */
  windowLeftMs: number | null;
}

export interface EtaLine {
  text: string;
  /** True when the drive needed is more than the clock allows. */
  past: boolean;
}

/**
 * The status card's ETA line against his real clocks (point 5). The tighter of the drive clock and the 14-hour window decides.
 * Display only: the remaining times come from the one HOS read; nothing is recomputed. The ETA is labelled in the zone the
 * truck is in (map fix 2026-11-12: it used to say "ET" always, even in Central); callers that pass no zone get home time.
 */
export function etaAgainstClocks(etaAt: string, minutesLeft: number, clocks: ClockInput, timeZone: string = HOME_TIME_ZONE): EtaLine {
  const eta = `ETA ${formatClock(etaAt, timeZone)}`;
  const candidates: { name: string; leftMin: number }[] = [];
  if (clocks.driveLeftMs !== null && Number.isFinite(clocks.driveLeftMs)) candidates.push({ name: "drive clock", leftMin: clocks.driveLeftMs / 60_000 });
  if (clocks.windowLeftMs !== null && Number.isFinite(clocks.windowLeftMs)) candidates.push({ name: "14-hour window", leftMin: clocks.windowLeftMs / 60_000 });
  if (candidates.length === 0) return { text: `${eta} — your hours aren't available to compare`, past: false };
  const tightest = candidates.reduce((a, b) => (b.leftMin < a.leftMin ? b : a));
  const over = minutesLeft - tightest.leftMin;
  if (over > 0) return { text: `${eta} — past your ${tightest.name} by ~${span(over)}`, past: true };
  return { text: `${eta} — inside your ${tightest.name} (${span(-over)} to spare, no breaks counted)`, past: false };
}

export const formatMiles = (miles: number): string => (miles >= 10 ? `${Math.round(miles).toLocaleString("en-US")} mi` : miles >= 0.2 ? `${miles.toFixed(1)} mi` : `${Math.round(miles * 5280 / 50) * 50} ft`);
