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
  weekLeftMin: number; // of the 70h / 8-day on-duty limit
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

export function clocksFromHos(hos: HosSummary | null): ClockState {
  if (!hos || hos.windowStart === null) {
    return {
      driveLeftMin: DRIVE_LIMIT_MIN,
      windowLeftMin: WINDOW_LIMIT_MIN,
      breakLeftMin: BREAK_AFTER_MIN,
      weekLeftMin: WEEK_LIMIT_MIN,
      fromLogs: false,
    };
  }
  return {
    driveLeftMin: Math.max(0, DRIVE_LIMIT_MIN - hos.drivingMinutesInWindow),
    windowLeftMin: Math.max(0, WINDOW_LIMIT_MIN - hos.windowElapsedMinutes),
    breakLeftMin: Math.max(0, BREAK_AFTER_MIN - hos.drivingMinutesSinceBreak),
    weekLeftMin: Math.max(0, WEEK_LIMIT_MIN - hos.onDutyMinutesLast8Days),
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
}

interface SimulateResult extends RoutePlan {
  clocks: ClockState;
}

function simulate(
  departAtMs: number,
  driveMinutesNeeded: number,
  distanceMiles: number,
  clocksIn: ClockState,
): SimulateResult {
  let { driveLeftMin, windowLeftMin, breakLeftMin, weekLeftMin } = clocksIn;
  let elapsed = 0;
  let driven = 0;
  const breaks: PlannedBreak[] = [];
  const rests: PlannedRest[] = [];
  const checkpoints = [{ drivenMinutes: 0, elapsedMinutes: 0 }];

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
        clocks: clocksIn,
      };
    }
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
        clocks: clocksIn,
      };
    }

    const step = Math.min(driveLeftMin, windowLeftMin, breakLeftMin, weekLeftMin, driveMinutesNeeded - driven);
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
    if (breakLeftMin <= 0 && driveLeftMin > 0 && windowLeftMin > BREAK_MIN) {
      breaks.push({
        startAt: new Date(departAtMs + elapsed * 60_000).toISOString(),
        afterDrivingMinutes: driven,
      });
      elapsed += BREAK_MIN;
      windowLeftMin -= BREAK_MIN;
      breakLeftMin = BREAK_AFTER_MIN;
      checkpoints.push({ drivenMinutes: driven, elapsedMinutes: elapsed });
      continue;
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
    clocks: clocksIn,
  };
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
}

export type RouteCheckStatus = "on_time" | "early" | "late" | "not_legal";

export interface RouteCheckResult {
  status: RouteCheckStatus;
  /** The planned drive time actually used, and why (provider vs truck-profile speed). */
  assumedDriveMinutes: number;
  driveTimeBasis: string;
  legalLines: string[];
  restedLines: string[];
  paidLines: string[];
  tradeoffLines: string[];
  warnings: string[];
  plan: RoutePlan | null;
  /** Departure that arrives exactly at the delivery window's close, when one exists. */
  makeItDepartureAt: string | null;
}

export function checkRoute(input: RouteCheckInput): RouteCheckResult {
  const warnings: string[] = [];
  const legalLines: string[] = [];
  const restedLines: string[] = [];
  const paidLines: string[] = [];
  const tradeoffLines: string[] = [];

  if (!input.clocks.fromLogs) {
    warnings.push(
      "No duty logs in the app yet - this plan assumes fresh clocks (full 11/14/70 available). Log your duty status in Fleet → Hours of service to plan against your real clocks. The truck's ELD is the legal record either way.",
    );
  }

  // Planned drive time: the slower of the provider's estimate and the
  // truck-profile speed math - a governed truck on real roads does not
  // beat either number, so the plan takes the honest (longer) one.
  const planSpeed = input.governedSpeedMph ?? DEFAULT_PLAN_SPEED_MPH;
  const speedMinutes = (input.distanceMiles / planSpeed) * 60;
  const assumedDriveMinutes = Math.max(input.providerDurationMinutes, speedMinutes);
  const driveTimeBasis =
    speedMinutes > input.providerDurationMinutes
      ? `planned at a ${planSpeed} mph average${input.governedSpeedMph ? " from the truck profile's governed speed" : " (default - no governed speed on the truck profile)"}, slower than the routing estimate`
      : "the routing estimate, which is slower than the truck profile's speed math";

  const plan = simulate(
    input.departAt.getTime(),
    assumedDriveMinutes,
    input.distanceMiles,
    input.clocks,
  );

  if (input.pickupWindow) {
    const start = new Date(input.pickupWindow.start).getTime();
    const end = new Date(input.pickupWindow.end).getTime();
    if (input.departAt.getTime() < start) {
      warnings.push(
        `Planned departure (${formatEastern(input.departAt)}) is before the pickup window opens (${formatEastern(new Date(start))}) - loading time isn't modeled, so check the actual pickup time with dispatch.`,
      );
    } else if (input.departAt.getTime() > end) {
      warnings.push(
        `Planned departure (${formatEastern(input.departAt)}) is after the pickup window closes (${formatEastern(new Date(end))}) - check the pickup time with dispatch before running this plan.`,
      );
    }
  }

  if (!plan.feasible) {
    legalLines.push(`Not legal as planned: ${plan.infeasibleReason}.`);
    return {
      status: "not_legal",
      assumedDriveMinutes,
      driveTimeBasis,
      legalLines,
      restedLines,
      paidLines,
      tradeoffLines,
      warnings,
      plan,
      makeItDepartureAt: null,
    };
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
      `This load pays $${(input.rateCents / 100).toFixed(2)} over ${input.loadMiles} miles - $${rpm.toFixed(2)} a mile, before fuel and the drive back out.`,
    );
  } else if (input.rateCents !== null) {
    paidLines.push(
      `This load pays $${(input.rateCents / 100).toFixed(2)}; no miles on the load yet, so no per-mile figure.`,
    );
  }

  let status: RouteCheckStatus = "on_time";
  let makeItDepartureAt: string | null = null;
  if (input.deliveryWindow) {
    const winStart = new Date(input.deliveryWindow.start).getTime();
    const winEnd = new Date(input.deliveryWindow.end).getTime();
    const arrivalMs = arrival.getTime();
    makeItDepartureAt = new Date(winEnd - plan.totalElapsedMinutes * 60_000).toISOString();

    if (arrivalMs > winEnd) {
      status = "late";
      const lateMin = (arrivalMs - winEnd) / 60_000;
      tradeoffLines.push(
        `Leaving at ${formatEastern(input.departAt)} gets you there ${formatMinutes(lateMin)} after the window closes. Leaving by ${formatEastern(new Date(makeItDepartureAt))} makes the window, with the same rest plan.`,
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

  return {
    status,
    assumedDriveMinutes,
    driveTimeBasis,
    legalLines,
    restedLines,
    paidLines,
    tradeoffLines,
    warnings,
    plan,
    makeItDepartureAt,
  };
}
