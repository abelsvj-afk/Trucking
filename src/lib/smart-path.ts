// Smart Path v1 (docs/design/driver-mvp.md §8). Deterministic route
// planning against the driver's real HOS clocks - no AI, no network.
// Everything here is pure and unit-tested; the network providers live
// in src/services/integrations and the orchestration in
// src/services/smart-path.
//
// WARN-ONLY, same standing as src/lib/hos.ts: this is a planning
// helper built from what the driver logged in the app. The truck's
// ELD remains the legal record. A plan that says "legal" means
// "legal against these logged clocks and federal limits" - it never
// certifies anything.

import type { HosSummary } from "./hos";
import { formatMoney } from "@/lib/money-format";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface TimeWindow {
  start: string; // ISO timestamp
  end: string; // ISO timestamp
}

/** Remaining clocks, in minutes, at the moment of planning. */
export interface ClockState {
  driveLeftMin: number; // of the 11h driving limit
  windowLeftMin: number; // of the 14h window
  breakLeftMin: number; // driving allowed before a 30-min break is due
  weekLeftMin: number; // left in the carrier-anchored cycle (70/8 or 60/7)
  /** False when there were no duty logs and fresh clocks were assumed. */
  fromLogs: boolean;
}

const DRIVE_LIMIT_MIN = 11 * 60;
const WINDOW_LIMIT_MIN = 14 * 60;
const BREAK_AFTER_MIN = 8 * 60;
const BREAK_MIN = 30;
const REST_MIN = 10 * 60;
const WEEK_LIMIT_MIN = 70 * 60;
/** Planning average when the truck profile has no governed speed. */
export const DEFAULT_PLAN_SPEED_MPH = 55;

/**
 * Planned drive minutes for a leg: the slower of the routing
 * provider's own duration and the governed/profile speed math over
 * the leg's distance. One honesty rule, applied to every leg -
 * the loaded leg in checkRoute and the deadhead leg alike (P1-7).
 */
export function plannedDriveMinutes(
  distanceMiles: number,
  providerDurationMinutes: number,
  governedSpeedMph: number | null,
): number {
  const planSpeed = governedSpeedMph ?? DEFAULT_PLAN_SPEED_MPH;
  return Math.max(providerDurationMinutes, (distanceMiles / planSpeed) * 60);
}

/**
 * The one caption that says which engine drew the route and whether
 * it was truck-checked (P1-1). The map component and the result
 * paragraph both render this - neither owns its own copy anymore.
 */
export function routeCaption(route: { provider: string; truckLegal: boolean }): string {
  return route.truckLegal
    ? `Route by ${route.provider} — truck-checked against the height/weight limits and truck-prohibited roads recorded in OpenStreetMap data. That data is incomplete: a road with no recorded limit reads as passable. The truck's own nav/ELD is the final word.`
    : `Route by ${route.provider} — a standard CAR route, NOT checked against truck restrictions. Don't roll on this line alone; check it against the truck's own nav/ELD.`;
}

/**
 * `cycleLeftMin` is the carrier-anchored cycle's remaining on-duty
 * time (services/api/hos-window.ts). hos.ts's rolling 8-day sum is
 * never used for the week clock (King review D-1).
 */
export function clocksFromHos(hos: HosSummary | null, cycleLeftMin: number): ClockState {
  if (!hos || hos.windowStart === null) {
    return {
      driveLeftMin: DRIVE_LIMIT_MIN,
      windowLeftMin: WINDOW_LIMIT_MIN,
      breakLeftMin: BREAK_AFTER_MIN,
      weekLeftMin: cycleLeftMin,
      fromLogs: false,
    };
  }
  return {
    driveLeftMin: Math.max(0, DRIVE_LIMIT_MIN - hos.drivingMinutesInWindow),
    windowLeftMin: Math.max(0, WINDOW_LIMIT_MIN - hos.windowElapsedMinutes),
    breakLeftMin: Math.max(0, BREAK_AFTER_MIN - hos.drivingMinutesSinceBreak),
    weekLeftMin: Math.max(0, cycleLeftMin),
    fromLogs: true,
  };
}

// ---------------------------------------------------------------- time in ET

const ET = "America/New_York";

/** Hour of day (0-23) in America/New_York for an instant. */
export function easternHour(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return hour % 24;
}

/** The owner's standing fast: 8pm-8am Eastern. */
export function isInFastWindow(date: Date): boolean {
  const hour = easternHour(date);
  return hour >= 20 || hour < 8;
}

/** "12 AM" / "12 PM" / "10 PM" - for naming a sleep window (P1-9). */
export function formatHour(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
}

/** Hour and minute of day in America/New_York for an instant. */
function easternHourMinute(date: Date): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { hour, minute };
}

interface SleepWindowJudgment {
  inside: boolean;
  /** Outside only: "before" the window's next start (a later
   * departure can still land the sleep inside it) or "after" -
   * already past the end of the night it belonged to, which a
   * later departure cannot pull back. */
  side: "inside" | "before" | "after";
  /** Minutes from the judged instant until the window next opens
   * (only meaningful when side is "before"). */
  deltaToStartMinutes: number;
}

/**
 * Judge an instant against a sleep window given as Eastern hours
 * [start, end), wrapping midnight. The outside hours are split at
 * the midpoint between the window's end and its next start: a rest
 * starting just after the end belongs to the night just passed
 * ("after"), one starting in the run-up to the next start belongs
 * to the coming night ("before").
 */
function judgeSleepWindow(date: Date, startHour: number, endHour: number): SleepWindowJudgment {
  const { hour, minute } = easternHourMinute(date);
  const pos = (((hour * 60 + minute - startHour * 60) % 1440) + 1440) % 1440;
  const length = startHour === endHour ? 1440 : (((endHour - startHour) * 60) % 1440 + 1440) % 1440;
  if (pos < length) return { inside: true, side: "inside", deltaToStartMinutes: 0 };
  const afterSpan = (1440 - length) / 2;
  if (pos >= length + afterSpan) {
    return { inside: false, side: "before", deltaToStartMinutes: 1440 - pos };
  }
  return { inside: false, side: "after", deltaToStartMinutes: 1440 - pos };
}

/** "Mon Nov 2, 7:40 AM ET" - display only, always Eastern per the owner's timezone rule. */
export function formatEastern(date: Date): string {
  const base = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${base} ET`;
}

export function formatMinutes(totalMinutes: number): string {
  const rounded = Math.round(totalMinutes);
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

// ------------------------------------------------------------------- geometry

const EARTH_RADIUS_MILES = 3958.8;

export function haversineMiles(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(s));
}

/** Distance from a point to the nearest route vertex (vertex approximation, documented in design §8.1). */
export function distanceToRouteMiles(point: LatLng, geometry: LatLng[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const vertex of geometry) {
    const d = haversineMiles(point, vertex);
    if (d < best) best = d;
  }
  return best;
}

/** Fraction (0-1) of total route length at the geometry vertex nearest the point. */
export function routeFractionOfPoint(point: LatLng, geometry: LatLng[]): number {
  if (geometry.length < 2) return 0;
  const cumulative: number[] = [0];
  for (let i = 1; i < geometry.length; i++) {
    cumulative.push(cumulative[i - 1]! + haversineMiles(geometry[i - 1]!, geometry[i]!));
  }
  const total = cumulative[cumulative.length - 1] || 1;
  let bestIdx = 0;
  let best = Number.POSITIVE_INFINITY;
  geometry.forEach((vertex, i) => {
    const d = haversineMiles(point, vertex);
    if (d < best) {
      best = d;
      bestIdx = i;
    }
  });
  return cumulative[bestIdx]! / total;
}

/** The point at a fraction of the route's length, walking the geometry. */
export function pointAlongRoute(geometry: LatLng[], fraction: number): LatLng | null {
  if (geometry.length === 0) return null;
  if (geometry.length === 1 || fraction <= 0) return geometry[0]!;
  const total = geometry.reduce(
    (sum, vertex, i) => (i === 0 ? sum : sum + haversineMiles(geometry[i - 1]!, vertex)),
    0,
  );
  const target = total * Math.min(1, fraction);
  let walked = 0;
  for (let i = 1; i < geometry.length; i++) {
    const seg = haversineMiles(geometry[i - 1]!, geometry[i]!);
    if (walked + seg >= target) {
      const t = seg === 0 ? 0 : (target - walked) / seg;
      return {
        lat: geometry[i - 1]!.lat + (geometry[i]!.lat - geometry[i - 1]!.lat) * t,
        lng: geometry[i - 1]!.lng + (geometry[i]!.lng - geometry[i - 1]!.lng) * t,
      };
    }
    walked += seg;
  }
  return geometry[geometry.length - 1]!;
}

// ----------------------------------------------------------------- simulation

export interface PlannedBreak {
  startAt: string;
  afterDrivingMinutes: number;
  /** 30 for a normal HOS break; longer when the break was extended
   * or inserted to hold a workout (P1-9). */
  durationMinutes: number;
  kind: "break" | "workout";
}

/** A place near the route where a break could become a workout (P1-9). */
export interface WorkoutAnchor {
  name: string;
  kind: "gym" | "rest_area" | "parking" | "fuel_stop";
  drivenMinutes: number;
  point: LatLng;
}

export interface WorkoutOutcome {
  placed: boolean;
  startAt: string | null;
  durationMinutes: number;
  placeName: string | null;
  placeKind: WorkoutAnchor["kind"] | null;
  point: LatLng | null;
  note: string;
}

export interface PlannedRest {
  startAt: string;
  endAt: string;
  /** Miles from the route origin where the rest begins (for the map marker). */
  distanceMilesFromOrigin: number;
  fractionOfRoute: number;
  /** Eastern hour the sleep starts - the "rested" governor reads this. */
  startHourEastern: number;
}

export interface RoutePlan {
  feasible: boolean;
  infeasibleReason: string | null;
  arrivalAt: string | null;
  totalElapsedMinutes: number;
  drivingMinutes: number;
  breaks: PlannedBreak[];
  rests: PlannedRest[];
  /** driven-minutes -> elapsed-minutes checkpoints, for placing stops on the timeline. */
  checkpoints: { drivenMinutes: number; elapsedMinutes: number }[];
  /** The requested workout's outcome; null when none was requested (P1-9). */
  workout: WorkoutOutcome | null;
}

interface SimulateResult extends RoutePlan {
  clocks: ClockState;
}

interface SimulateOptions {
  /**
   * Off-duty waits at a driven-minutes point (P1-7: waiting at the
   * pickup for the planned loaded departure). A wait counts against
   * the 14 but not the 11; at 30+ minutes it satisfies the break
   * rule, and at 10+ hours it resets the drive/window clocks like a
   * rest - without fabricating a PlannedRest for it.
   */
  waits?: { atDrivenMinutes: number; minutes: number }[];
  /**
   * P1-9 strategy 1: when a break is inserted at the keyed
   * afterDrivingMinutes, hold it for the mapped duration instead of
   * 30 minutes; a mapped duration of 30+ marks the break a workout.
   */
  breakExtensions?: Map<number, number>;
  /**
   * P1-9: off-duty pauses inserted when the drive reaches a point,
   * recorded as workout breaks. Same clock treatment as a wait,
   * plus the break record.
   */
  pauses?: { atDrivenMinutes: number; minutes: number }[];
}

function simulate(
  departAtMs: number,
  driveMinutesNeeded: number,
  distanceMiles: number,
  clocksIn: ClockState,
  options: SimulateOptions = {},
): SimulateResult {
  let { driveLeftMin, windowLeftMin, breakLeftMin, weekLeftMin } = clocksIn;
  let elapsed = 0;
  let driven = 0;
  const breaks: PlannedBreak[] = [];
  const rests: PlannedRest[] = [];
  const checkpoints = [{ drivenMinutes: 0, elapsedMinutes: 0 }];
  const waits = [...(options.waits ?? [])].sort((a, b) => a.atDrivenMinutes - b.atDrivenMinutes);
  const pauses = [...(options.pauses ?? [])].sort((a, b) => a.atDrivenMinutes - b.atDrivenMinutes);
  let waitIdx = 0;
  let pauseIdx = 0;

  for (let guard = 0; guard < 100; guard++) {
    if (driven >= driveMinutesNeeded) {
      return {
        feasible: true,
        infeasibleReason: null,
        arrivalAt: new Date(departAtMs + elapsed * 60_000).toISOString(),
        totalElapsedMinutes: elapsed,
        drivingMinutes: driveMinutesNeeded,
        breaks,
        rests,
        checkpoints,
        workout: null,
        clocks: clocksIn,
      };
    }

    // Waits and pauses sitting at the point just reached apply
    // before any further driving: the checkpoint for arriving here
    // was already recorded by the driving step, then the off-duty
    // time is applied and a second checkpoint marks its end.
    let appliedEvent = false;
    while (waitIdx < waits.length && waits[waitIdx]!.atDrivenMinutes <= driven + 1e-9) {
      const wait = waits[waitIdx++]!;
      elapsed += wait.minutes;
      windowLeftMin = Math.max(0, windowLeftMin - wait.minutes);
      if (wait.minutes >= BREAK_MIN) breakLeftMin = BREAK_AFTER_MIN;
      if (wait.minutes >= REST_MIN) {
        driveLeftMin = DRIVE_LIMIT_MIN;
        windowLeftMin = WINDOW_LIMIT_MIN;
      }
      checkpoints.push({ drivenMinutes: driven, elapsedMinutes: elapsed });
      appliedEvent = true;
    }
    while (pauseIdx < pauses.length && pauses[pauseIdx]!.atDrivenMinutes <= driven + 1e-9) {
      const pause = pauses[pauseIdx++]!;
      breaks.push({
        startAt: new Date(departAtMs + elapsed * 60_000).toISOString(),
        afterDrivingMinutes: driven,
        durationMinutes: pause.minutes,
        kind: "workout",
      });
      elapsed += pause.minutes;
      windowLeftMin = Math.max(0, windowLeftMin - pause.minutes);
      if (pause.minutes >= BREAK_MIN) breakLeftMin = BREAK_AFTER_MIN;
      checkpoints.push({ drivenMinutes: driven, elapsedMinutes: elapsed });
      appliedEvent = true;
    }
    if (appliedEvent) continue;

    if (weekLeftMin <= 0) {
      return {
        feasible: false,
        infeasibleReason:
          "the 70-hour / 8-day clock runs out before this drive is done - a 10-hour rest does not fix that; it takes a 34-hour reset or waiting for hours to roll off",
        arrivalAt: null,
        totalElapsedMinutes: elapsed,
        drivingMinutes: driven,
        breaks,
        rests,
        checkpoints,
        workout: null,
        clocks: clocksIn,
      };
    }

    // Drive, but stop the step exactly at the next wait/pause point
    // so the event lands at its driven-minutes mark.
    let nextEventDriven = Number.POSITIVE_INFINITY;
    if (waitIdx < waits.length) nextEventDriven = Math.min(nextEventDriven, waits[waitIdx]!.atDrivenMinutes);
    if (pauseIdx < pauses.length) nextEventDriven = Math.min(nextEventDriven, pauses[pauseIdx]!.atDrivenMinutes);
    let step = Math.min(driveLeftMin, windowLeftMin, breakLeftMin, weekLeftMin, driveMinutesNeeded - driven);
    if (nextEventDriven !== Number.POSITIVE_INFINITY) {
      const toEvent = nextEventDriven - driven;
      if (toEvent > 0) step = Math.min(step, toEvent);
    }
    if (step > 0) {
      driven += step;
      elapsed += step;
      driveLeftMin -= step;
      windowLeftMin -= step;
      breakLeftMin -= step;
      weekLeftMin -= step;
      checkpoints.push({ drivenMinutes: driven, elapsedMinutes: elapsed });
      continue;
    }

    // A clock is exhausted. A 30-minute break only helps if the break
    // clock is the binding one and the break fits inside the window.
    // A break extension (workout) lengthens both the hold and the
    // window it must fit inside.
    if (breakLeftMin <= 0 && driveLeftMin > 0) {
      let extension: number | undefined;
      if (options.breakExtensions) {
        extension = options.breakExtensions.get(driven);
        if (extension === undefined) {
          for (const [key, value] of options.breakExtensions) {
            if (Math.abs(key - driven) < 1e-6) {
              extension = value;
              break;
            }
          }
        }
      }
      const breakDuration = extension ?? BREAK_MIN;
      if (windowLeftMin > breakDuration) {
        breaks.push({
          startAt: new Date(departAtMs + elapsed * 60_000).toISOString(),
          afterDrivingMinutes: driven,
          durationMinutes: breakDuration,
          kind: extension !== undefined && breakDuration >= BREAK_MIN ? "workout" : "break",
        });
        elapsed += breakDuration;
        windowLeftMin -= breakDuration;
        breakLeftMin = BREAK_AFTER_MIN;
        checkpoints.push({ drivenMinutes: driven, elapsedMinutes: elapsed });
        continue;
      }
    }

    // Drive or window clock is done: a 10-hour rest resets both.
    const restStart = new Date(departAtMs + elapsed * 60_000);
    const fraction = driveMinutesNeeded === 0 ? 0 : driven / driveMinutesNeeded;
    rests.push({
      startAt: restStart.toISOString(),
      endAt: new Date(departAtMs + (elapsed + REST_MIN) * 60_000).toISOString(),
      distanceMilesFromOrigin: Math.round(distanceMiles * fraction),
      fractionOfRoute: fraction,
      startHourEastern: easternHour(restStart),
    });
    elapsed += REST_MIN;
    driveLeftMin = DRIVE_LIMIT_MIN;
    windowLeftMin = WINDOW_LIMIT_MIN;
    breakLeftMin = BREAK_AFTER_MIN;
    checkpoints.push({ drivenMinutes: driven, elapsedMinutes: elapsed });
  }

  return {
    feasible: false,
    infeasibleReason: "the plan needed more than 100 steps - treated as not plannable rather than guessed",
    arrivalAt: null,
    totalElapsedMinutes: elapsed,
    drivingMinutes: driven,
    breaks,
    rests,
    checkpoints,
    workout: null,
    clocks: clocksIn,
  };
}

/** Driven minutes at which a given elapsed-minutes point is reached (inverse of elapsedAtDrivenMinutes). */
function drivenAtElapsedMinutes(plan: RoutePlan, elapsedMinutes: number): number {
  const points = plan.checkpoints;
  if (points.length === 0) return 0;
  for (let i = 1; i < points.length; i++) {
    if (elapsedMinutes <= points[i]!.elapsedMinutes) {
      const prev = points[i - 1]!;
      const span = points[i]!.elapsedMinutes - prev.elapsedMinutes;
      if (span === 0) return points[i]!.drivenMinutes;
      const t = (elapsedMinutes - prev.elapsedMinutes) / span;
      return prev.drivenMinutes + t * (points[i]!.drivenMinutes - prev.drivenMinutes);
    }
  }
  return points[points.length - 1]!.drivenMinutes;
}

/** Elapsed minutes from departure at which a given driven-minutes point is reached. */
export function elapsedAtDrivenMinutes(plan: RoutePlan, drivenMinutes: number): number {
  const points = plan.checkpoints;
  if (points.length === 0) return 0;
  for (let i = 1; i < points.length; i++) {
    if (drivenMinutes <= points[i]!.drivenMinutes) {
      const prev = points[i - 1]!;
      const span = points[i]!.drivenMinutes - prev.drivenMinutes;
      if (span === 0) return points[i]!.elapsedMinutes;
      const t = (drivenMinutes - prev.drivenMinutes) / span;
      return prev.elapsedMinutes + t * (points[i]!.elapsedMinutes - prev.elapsedMinutes);
    }
  }
  return points[points.length - 1]!.elapsedMinutes;
}

// -------------------------------------------------------------------- verdict

export interface RouteCheckInput {
  now: Date;
  departAt: Date;
  distanceMiles: number;
  /** The routing provider's own duration estimate for the leg. */
  providerDurationMinutes: number;
  clocks: ClockState;
  governedSpeedMph: number | null;
  pickupWindow: TimeWindow | null;
  deliveryWindow: TimeWindow | null;
  rateCents: number | null;
  loadMiles: number | null;
  /**
   * Piece 1 (P1-7): the deadhead leg to the pickup. Absent = the
   * check starts at the pickup, exactly as before. startAt null =
   * "leave just in time" (departAt minus the planned leg).
   */
  preLeg?: {
    distanceMiles: number;
    providerDurationMinutes: number;
    startAt: Date | null;
    startLabel?: string;
  };
  /** Piece 1 (P1-9): per-request life preferences. Absent = today's behavior. */
  life?: {
    sleepStartHour?: number;
    sleepEndHour?: number;
    workout?: {
      want: boolean;
      minutes: number;
      setting: "gym_preferred" | "any_safe_stop";
    };
  };
  /** Places the workout strategies may anchor to (P1-9). */
  workoutAnchors?: WorkoutAnchor[];
}

export type RouteCheckStatus = "on_time" | "early" | "late" | "not_legal";

export interface RouteCheckResult {
  status: RouteCheckStatus;
  /** The planned drive time actually used, and why (provider vs truck-profile speed). */
  assumedDriveMinutes: number;
  driveTimeBasis: string;
  legalLines: string[];
  restedLines: string[];
  /** The LIFE governor's voice: sleep-window fixes and the workout outcome (P1-9). */
  lifeLines: string[];
  paidLines: string[];
  tradeoffLines: string[];
  warnings: string[];
  plan: RoutePlan | null;
  /** Departure that arrives exactly at the delivery window's close, when one exists. */
  makeItDepartureAt: string | null;
  /**
   * Start departure (from the deadhead start) that arrives exactly
   * at the delivery window's close. Only with a preLeg AND a
   * delivery window; null otherwise (P1-7).
   */
  leaveStartByAt: string | null;
  /** The deadhead leg's planned figures; null when no preLeg was given (P1-7). */
  preLeg: {
    plannedMinutes: number;
    startAt: string;
    pickupArrivalAt: string;
    waitMinutesAtPickup: number;
  } | null;
}

export function checkRoute(input: RouteCheckInput): RouteCheckResult {
  const warnings: string[] = [];
  const legalLines: string[] = [];
  const restedLines: string[] = [];
  const lifeLines: string[] = [];
  const paidLines: string[] = [];
  const tradeoffLines: string[] = [];

  if (!input.clocks.fromLogs) {
    warnings.push(
      "No duty logs in the app yet - this plan assumes fresh clocks (full 11/14/70 available). Log your duty status in Fleet → Day log to plan against your real clocks. The truck's ELD is the legal record either way.",
    );
  }

  // Planned drive time: the slower of the provider's estimate and the
  // truck-profile speed math - a governed truck on real roads does not
  // beat either number, so the plan takes the honest (longer) one.
  // The same rule plans the deadhead leg (plannedDriveMinutes, P1-7).
  const planSpeed = input.governedSpeedMph ?? DEFAULT_PLAN_SPEED_MPH;
  const speedMinutes = (input.distanceMiles / planSpeed) * 60;
  const assumedDriveMinutes = plannedDriveMinutes(
    input.distanceMiles,
    input.providerDurationMinutes,
    input.governedSpeedMph,
  );
  const driveTimeBasis =
    speedMinutes > input.providerDurationMinutes
      ? `planned at a ${planSpeed} mph average${input.governedSpeedMph ? " from the truck profile's governed speed" : " (default - no governed speed on the truck profile)"}, slower than the routing estimate`
      : "the routing estimate, which is slower than the truck profile's speed math";

  const departAtMs = input.departAt.getTime();

  // The solo plan - today's computation, from the pickup. Kept even
  // with a preLeg: it is what proves a run illegal *because of the
  // deadhead alone*, and it is the plan when there is no preLeg.
  const soloPlan = simulate(departAtMs, assumedDriveMinutes, input.distanceMiles, input.clocks);

  // ---- the deadhead leg (P1-7): simulate the combined drive -------
  const hasSleepWindow =
    input.life?.sleepStartHour !== undefined &&
    input.life?.sleepStartHour !== null &&
    input.life?.sleepEndHour !== undefined &&
    input.life?.sleepEndHour !== null;
  const workoutRequest = input.life?.workout?.want ? input.life.workout : null;

  let simStartMs = departAtMs;
  let totalDriveMinutes = assumedDriveMinutes;
  let totalDistanceMiles = input.distanceMiles;
  let plannedPreLeg = 0;
  let pickupElapsed = 0;
  let waitMinutesAtPickup = 0;
  let pickupArrivalMs: number | null = null;
  let waitsForFinal: { atDrivenMinutes: number; minutes: number }[] | undefined;
  let baselinePlan: SimulateResult = soloPlan;

  if (input.preLeg) {
    plannedPreLeg = plannedDriveMinutes(
      input.preLeg.distanceMiles,
      input.preLeg.providerDurationMinutes,
      input.governedSpeedMph,
    );
    simStartMs = input.preLeg.startAt
      ? input.preLeg.startAt.getTime()
      : departAtMs - plannedPreLeg * 60_000;
    totalDriveMinutes = plannedPreLeg + assumedDriveMinutes;
    totalDistanceMiles = input.preLeg.distanceMiles + input.distanceMiles;

    const pass1 = simulate(simStartMs, totalDriveMinutes, totalDistanceMiles, input.clocks);
    pickupElapsed = elapsedAtDrivenMinutes(pass1, plannedPreLeg);
    pickupArrivalMs = simStartMs + pickupElapsed * 60_000;
    if (pickupArrivalMs < departAtMs) {
      // Early at the pickup: the gap is a wait there - elapsed time
      // against the 14, not driven time - and the loaded leg still
      // departs at departAt. Pass 2 with the wait is the final plan.
      waitMinutesAtPickup = (departAtMs - pickupArrivalMs) / 60_000;
      waitsForFinal = [{ atDrivenMinutes: plannedPreLeg, minutes: waitMinutesAtPickup }];
      baselinePlan = simulate(simStartMs, totalDriveMinutes, totalDistanceMiles, input.clocks, {
        waits: waitsForFinal,
      });
    } else {
      // On time or slipping: pass 1 is the final plan; a slip moves
      // the loaded departure to the pickup arrival.
      baselinePlan = pass1;
    }
  }

  const preLegResult = input.preLeg
    ? {
        plannedMinutes: plannedPreLeg,
        startAt: new Date(simStartMs).toISOString(),
        pickupArrivalAt: new Date(pickupArrivalMs!).toISOString(),
        waitMinutesAtPickup,
      }
    : null;

  if (input.pickupWindow) {
    // With a deadhead, the window judges when he'd actually reach
    // the pickup - not the planned loaded departure.
    const checkMs = pickupArrivalMs ?? departAtMs;
    const start = new Date(input.pickupWindow.start).getTime();
    const end = new Date(input.pickupWindow.end).getTime();
    if (checkMs < start) {
      warnings.push(
        `Planned departure (${formatEastern(new Date(checkMs))}) is before the pickup window opens (${formatEastern(new Date(start))}) - loading time isn't modeled, so check the actual pickup time with dispatch.`,
      );
    } else if (checkMs > end) {
      warnings.push(
        `Planned departure (${formatEastern(new Date(checkMs))}) is after the pickup window closes (${formatEastern(new Date(end))}) - check the pickup time with dispatch before running this plan.`,
      );
    }
  }

  if (input.preLeg && simStartMs > input.now.getTime()) {
    warnings.push("Clocks are projected from your logs as of now.");
  }

  if (!baselinePlan.feasible) {
    legalLines.push(`Not legal as planned: ${baselinePlan.infeasibleReason}.`);
    if (input.preLeg && soloPlan.feasible) {
      tradeoffLines.push(
        `From the pickup this run was legal. From ${input.preLeg.startLabel ?? "your start"}, the deadhead burns ${formatMinutes(plannedPreLeg)} of your 14 first.`,
      );
    }
    if (workoutRequest) {
      baselinePlan.workout = {
        placed: false,
        startAt: null,
        durationMinutes: workoutRequest.minutes,
        placeName: null,
        placeKind: null,
        point: null,
        note: "No workout to place — this run isn't legal as planned.",
      };
    }
    return {
      status: "not_legal",
      assumedDriveMinutes,
      driveTimeBasis,
      legalLines,
      restedLines,
      lifeLines,
      paidLines,
      tradeoffLines,
      warnings,
      plan: baselinePlan,
      makeItDepartureAt: null,
      leaveStartByAt: null,
      preLeg: preLegResult,
    };
  }

  // ---- workout placement (P1-9): after the final feasible plan ----
  // ---- exists; the first strategy whose trial stays feasible ----
  // ---- and inside the delivery window wins. -----------------------
  let plan: SimulateResult = baselinePlan;
  let workoutOutcome: WorkoutOutcome | null = null;
  const workoutLifeLines: string[] = [];

  if (workoutRequest) {
    const minutes = workoutRequest.minutes;
    const setting = workoutRequest.setting;
    const anchors = input.workoutAnchors ?? [];
    const winEndMs = input.deliveryWindow ? new Date(input.deliveryWindow.end).getTime() : null;
    let leastOverrunMinutes: number | null = null;
    let sawInfeasibleTrial = false;
    let sawSleepBlockedTrial = false;

    const simulateTrial = (opts: SimulateOptions): SimulateResult =>
      simulate(simStartMs, totalDriveMinutes, totalDistanceMiles, input.clocks, {
        ...(waitsForFinal ? { waits: waitsForFinal } : {}),
        ...opts,
      });
    // Records the trial's failure shape (overrun / infeasibility)
    // for the not-placed note, and answers the base acceptance rule.
    const trialAccepts = (trial: SimulateResult): boolean => {
      if (!trial.feasible) {
        sawInfeasibleTrial = true;
        return false;
      }
      if (winEndMs !== null) {
        const trialArrivalMs = new Date(trial.arrivalAt!).getTime();
        if (trialArrivalMs > winEndMs) {
          const overrun = (trialArrivalMs - winEndMs) / 60_000;
          if (leastOverrunMinutes === null || overrun < leastOverrunMinutes) {
            leastOverrunMinutes = overrun;
          }
          return false;
        }
      }
      return true;
    };
    const workoutBreakAt = (trial: SimulateResult, drivenMinutes: number) =>
      trial.breaks.find(
        (b) => b.kind === "workout" && Math.abs(b.afterDrivingMinutes - drivenMinutes) < 1e-6,
      );
    const nearestAnchor = (pool: WorkoutAnchor[], aroundDriven: number) =>
      pool.reduce((best, a) =>
        Math.abs(a.drivenMinutes - aroundDriven) < Math.abs(best.drivenMinutes - aroundDriven) ? a : best,
      );
    const placeWorkout = (
      finalPlan: SimulateResult,
      startAt: string,
      placeName: string,
      placeKind: WorkoutAnchor["kind"],
      point: LatLng | null,
      line: string,
    ) => {
      const bodyweight =
        setting === "gym_preferred" && placeKind !== "gym"
          ? " No gym near this stop — it's a bodyweight spot; your normal session works here."
          : "";
      workoutOutcome = {
        placed: true,
        startAt,
        durationMinutes: minutes,
        placeName,
        placeKind,
        point,
        note: line + bodyweight,
      };
      plan = finalPlan;
      workoutLifeLines.push(line);
      if (bodyweight) workoutLifeLines.push(bodyweight.trim());
    };

    // Strategy 1: extend the first planned break at a nearby anchor.
    if (plan === baselinePlan && baselinePlan.breaks.length > 0) {
      const break0 = baselinePlan.breaks[0]!;
      const near = anchors.filter(
        (a) => Math.abs(a.drivenMinutes - break0.afterDrivingMinutes) <= 120,
      );
      if (near.length > 0) {
        const gyms = near.filter((a) => a.kind === "gym");
        const chosen =
          setting === "gym_preferred" && gyms.length > 0
            ? nearestAnchor(gyms, break0.afterDrivingMinutes)
            : nearestAnchor(near, break0.afterDrivingMinutes);
        const line = `Workout: ${minutes} minutes at ${chosen.name} — it doubles as your 30-minute break.`;
        if (minutes === 30) {
          if (winEndMs === null || new Date(baselinePlan.arrivalAt!).getTime() <= winEndMs) {
            const relabeled: SimulateResult = {
              ...baselinePlan,
              breaks: baselinePlan.breaks.map((b, i) =>
                i === 0 ? { ...b, kind: "workout" as const, durationMinutes: 30 } : b,
              ),
            };
            placeWorkout(relabeled, break0.startAt, chosen.name, chosen.kind, chosen.point, line);
          } else {
            leastOverrunMinutes =
              (new Date(baselinePlan.arrivalAt!).getTime() - winEndMs) / 60_000;
          }
        } else if (minutes > 30) {
          const trial = simulateTrial({
            breakExtensions: new Map([[break0.afterDrivingMinutes, minutes]]),
          });
          const ok = trialAccepts(trial);
          const wb = workoutBreakAt(trial, break0.afterDrivingMinutes);
          if (ok && wb) placeWorkout(trial, wb.startAt, chosen.name, chosen.kind, chosen.point, line);
        }
      }
    }

    // Strategy 2: stack on the first fuel-stop anchor.
    if (!workoutOutcome) {
      const fuelAnchor = anchors.find((a) => a.kind === "fuel_stop");
      if (fuelAnchor && fuelAnchor.drivenMinutes >= 0 && fuelAnchor.drivenMinutes < totalDriveMinutes) {
        const trial = simulateTrial({
          pauses: [{ atDrivenMinutes: fuelAnchor.drivenMinutes, minutes }],
        });
        const ok = trialAccepts(trial);
        const wb = workoutBreakAt(trial, fuelAnchor.drivenMinutes);
        if (ok && wb) {
          placeWorkout(
            trial,
            wb.startAt,
            fuelAnchor.name,
            fuelAnchor.kind,
            fuelAnchor.point,
            `Workout: ${minutes} minutes at ${fuelAnchor.name} — stacked on your fuel stop.`,
          );
        }
      }
    }

    // Strategy 3: stack on rest arrival - train, then sleep.
    if (!workoutOutcome && baselinePlan.rests.length > 0) {
      const rest0 = baselinePlan.rests[0]!;
      const restStartElapsed = (new Date(rest0.startAt).getTime() - simStartMs) / 60_000;
      const drivenAtRest = drivenAtElapsedMinutes(baselinePlan, restStartElapsed);
      const trial = simulateTrial({ pauses: [{ atDrivenMinutes: drivenAtRest, minutes }] });
      const ok = trialAccepts(trial);
      const wb = workoutBreakAt(trial, drivenAtRest);
      let sleepOk = true;
      if (ok && wb && hasSleepWindow && trial.rests.length > 0) {
        const shifted = judgeSleepWindow(
          new Date(trial.rests[0]!.startAt),
          input.life!.sleepStartHour!,
          input.life!.sleepEndHour!,
        );
        if (shifted.side === "after") {
          sleepOk = false;
          sawSleepBlockedTrial = true;
        }
      }
      if (ok && wb && sleepOk) {
        placeWorkout(
          trial,
          wb.startAt,
          "Your sleep stop",
          "rest_area",
          null,
          `Workout: ${minutes} minutes at your sleep stop — train on arrival, then sleep.`,
        );
      }
    }

    // Strategy 4: standalone pause at each anchor, earliest first.
    if (!workoutOutcome) {
      const sorted = [...anchors].sort((a, b) => a.drivenMinutes - b.drivenMinutes);
      for (const anchor of sorted) {
        if (anchor.drivenMinutes < 0 || anchor.drivenMinutes >= totalDriveMinutes) continue;
        const trial = simulateTrial({
          pauses: [{ atDrivenMinutes: anchor.drivenMinutes, minutes }],
        });
        const ok = trialAccepts(trial);
        const wb = workoutBreakAt(trial, anchor.drivenMinutes);
        if (ok && wb) {
          placeWorkout(
            trial,
            wb.startAt,
            anchor.name,
            anchor.kind,
            anchor.point,
            `Workout: ${minutes} minutes at ${anchor.name} — a standalone stop on this run.`,
          );
          break;
        }
      }
    }

    if (!workoutOutcome) {
      let note: string;
      if (leastOverrunMinutes !== null) {
        note = `No room for a ${minutes}-minute workout on this run: it would put you at the receiver ${formatMinutes(leastOverrunMinutes)} after the window closes. It fits if you leave ${formatMinutes(leastOverrunMinutes)}+ minutes earlier, or on the way back.`;
      } else if (sawInfeasibleTrial) {
        note = `No room for a ${minutes}-minute workout on this run: every spot tried would make the run not legal as planned.`;
      } else if (anchors.length === 0 && baselinePlan.rests.length === 0) {
        note = "No gym/rest area/fuel stop found near this route in the map data.";
      } else if (sawSleepBlockedTrial) {
        note = `No room for a ${minutes}-minute workout on this run: it would push your sleep past your sleep window's end.`;
      } else {
        note = `No room for a ${minutes}-minute workout on this run.`;
      }
      workoutOutcome = {
        placed: false,
        startAt: null,
        durationMinutes: minutes,
        placeName: null,
        placeKind: null,
        point: null,
        note,
      };
      workoutLifeLines.push(note);
    }
    plan.workout = workoutOutcome;
  }

  const arrival = new Date(plan.arrivalAt!);
  legalLines.push(
    `Legal against your ${input.clocks.fromLogs ? "logged" : "assumed-fresh"} clocks: ${formatMinutes(plan.drivingMinutes)} of driving` +
      (plan.breaks.length > 0
        ? `, with a 30-minute break after ${plan.breaks.map((b) => formatMinutes(b.afterDrivingMinutes)).join(", ")} of driving`
        : ", no break needed") +
      (plan.rests.length > 0
        ? `, and ${plan.rests.length} sleep stop${plan.rests.length > 1 ? "s" : ""} of 10 hours`
        : "") +
      `. You'd arrive ${formatEastern(arrival)}.`,
  );

  // Rested governor: where does the sleep actually land?
  if (plan.rests.length === 0) {
    restedLines.push("No sleep stop needed - the whole run fits inside one set of clocks.");
  } else if (hasSleepWindow) {
    // P1-9: judged against HIS window. The verdict line stays in
    // restedLines; the priced fix (or why there is none) goes to
    // lifeLines.
    const sleepStartHour = input.life!.sleepStartHour!;
    const sleepEndHour = input.life!.sleepEndHour!;
    const windowLabel = `${formatHour(sleepStartHour)}–${formatHour(sleepEndHour)}`;
    for (const rest of plan.rests) {
      const start = new Date(rest.startAt);
      const judgment = judgeSleepWindow(start, sleepStartHour, sleepEndHour);
      if (judgment.inside) {
        restedLines.push(
          `Sleep stop near mile ${rest.distanceMilesFromOrigin}: starts ${formatEastern(start)} - inside your ${windowLabel} window.`,
        );
      } else {
        restedLines.push(
          `Sleep stop near mile ${rest.distanceMilesFromOrigin}: starts ${formatEastern(start)} - outside your ${windowLabel} window.`,
        );
        if (judgment.side === "after") {
          lifeLines.push(
            `This sleep lands at ${formatEastern(start)}, outside your ${windowLabel} window — it's already past the window's end, so leaving later can't pull it back inside.`,
          );
        } else {
          const delta = judgment.deltaToStartMinutes;
          const shiftedStart = new Date(start.getTime() + delta * 60_000);
          const shiftedArrivalMs = arrival.getTime() + delta * 60_000;
          if (input.deliveryWindow && shiftedArrivalMs > new Date(input.deliveryWindow.end).getTime()) {
            lifeLines.push(
              `This sleep lands at ${formatEastern(start)}, outside your ${windowLabel} window. Leaving ${formatMinutes(delta)} later would put it at ${formatEastern(shiftedStart)}, inside, but that would miss the delivery window — the appointment blocks it.`,
            );
          } else {
            lifeLines.push(
              `This sleep lands at ${formatEastern(start)}, outside your ${windowLabel} window. Leaving ${formatMinutes(delta)} later puts it at ${formatEastern(shiftedStart)}, inside — if the pickup window allows.`,
            );
          }
        }
      }
    }
  } else {
    for (const rest of plan.rests) {
      const start = new Date(rest.startAt);
      if (rest.startHourEastern >= 20 || rest.startHourEastern < 5) {
        restedLines.push(
          `Sleep stop near mile ${rest.distanceMilesFromOrigin}: starts ${formatEastern(start)} - inside your normal night hours.`,
        );
      } else if (rest.startHourEastern >= 10 && rest.startHourEastern <= 16) {
        restedLines.push(
          `Sleep stop near mile ${rest.distanceMilesFromOrigin}: starts ${formatEastern(start)} - that's mid-day. Legal, but a rough sleep; if the appointment allows it, shifting departure so this rest lands at night is the rested move.`,
        );
      } else {
        restedLines.push(
          `Sleep stop near mile ${rest.distanceMilesFromOrigin}: starts ${formatEastern(start)} - an off-hours sleep, workable but not your normal night.`,
        );
      }
    }
  }

  // Paid governor: only from the load's own numbers.
  if (input.rateCents !== null && input.loadMiles !== null && input.loadMiles > 0) {
    const rpm = input.rateCents / 100 / input.loadMiles;
    paidLines.push(
      `This load pays ${formatMoney(input.rateCents)} over ${input.loadMiles} miles - $${rpm.toFixed(2)} a mile, before fuel and the drive back out.`,
    );
  } else if (input.rateCents !== null) {
    paidLines.push(
      `This load pays ${formatMoney(input.rateCents)}; no miles on the load yet, so no per-mile figure.`,
    );
  }

  // A slipped pickup departure is stated before the window math -
  // everything below starts from the pickup arrival, not departAt.
  if (input.preLeg && pickupArrivalMs !== null && pickupArrivalMs > departAtMs) {
    const slipMinutes = (pickupArrivalMs - departAtMs) / 60_000;
    tradeoffLines.push(
      `You'd reach the pickup ${formatMinutes(slipMinutes)} after your planned ${formatEastern(input.departAt)} departure — everything below starts from ${formatEastern(new Date(pickupArrivalMs))}.`,
    );
  }

  let status: RouteCheckStatus = "on_time";
  let makeItDepartureAt: string | null = null;
  let leaveStartByAt: string | null = null;
  if (input.deliveryWindow) {
    const winStart = new Date(input.deliveryWindow.start).getTime();
    const winEnd = new Date(input.deliveryWindow.end).getTime();
    const arrivalMs = arrival.getTime();
    // makeItDepartureAt keeps its "leave the pickup by" meaning:
    // the window close minus the elapsed time from the pickup
    // departure (pickup arrival + any wait) to the delivery. With
    // no preLeg the pickup departure is departAt itself and this
    // reduces to winEnd - total elapsed, as before.
    const pickupDepartElapsed = input.preLeg
      ? elapsedAtDrivenMinutes(plan, plannedPreLeg) + waitMinutesAtPickup
      : 0;
    makeItDepartureAt = new Date(
      winEnd - (plan.totalElapsedMinutes - pickupDepartElapsed) * 60_000,
    ).toISOString();
    leaveStartByAt = input.preLeg
      ? new Date(winEnd - plan.totalElapsedMinutes * 60_000).toISOString()
      : null;
    const pickupDepartMs = input.preLeg ? Math.max(departAtMs, pickupArrivalMs!) : departAtMs;

    if (arrivalMs > winEnd) {
      status = "late";
      const lateMin = (arrivalMs - winEnd) / 60_000;
      tradeoffLines.push(
        `Leaving at ${formatEastern(new Date(pickupDepartMs))} gets you there ${formatMinutes(lateMin)} after the window closes. Leaving by ${formatEastern(new Date(makeItDepartureAt))} makes the window, with the same rest plan.`,
      );
    } else if (arrivalMs < winStart) {
      status = "early";
      const earlyMin = (winStart - arrivalMs) / 60_000;
      tradeoffLines.push(
        `You'd arrive ${formatMinutes(earlyMin)} before the window opens - arriving early into a facility that won't take you is detention you scheduled yourself. Leaving as late as ${formatEastern(new Date(makeItDepartureAt))} still makes the close of the window.`,
      );
    } else {
      const spareMin = (winEnd - arrivalMs) / 60_000;
      tradeoffLines.push(
        `You make the window with ${formatMinutes(spareMin)} to spare. Latest you could leave and still make it: ${formatEastern(new Date(makeItDepartureAt))}.`,
      );
    }
  } else {
    tradeoffLines.push("No delivery window was given, so there's no appointment to judge against - add one to get the on-time math.");
  }

  lifeLines.push(...workoutLifeLines);

  return {
    status,
    assumedDriveMinutes,
    driveTimeBasis,
    legalLines,
    restedLines,
    lifeLines,
    paidLines,
    tradeoffLines,
    warnings,
    plan,
    makeItDepartureAt,
    leaveStartByAt,
    preLeg: preLegResult,
  };
}
