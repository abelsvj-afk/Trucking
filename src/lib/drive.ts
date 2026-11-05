// Drive Mode D1 - the rolling companion (design Piece 2, gate
// answers G-1...G-8). Everything deterministic lives here: the plan
// snapshot Drive consumes, the per-fix session evaluation (arrival,
// missed stops, GPS loss, HOS cliff projections), the closed spoken
// set's text, and the trip checkpoint. The page and map components
// are shells over these functions so a scripted run of positions
// can prove the behavior without a truck (D1 acceptance #6).
//
// HONESTY RULES carried from the gate, enforced in this layer:
// - A car-profile plan (truckLegal === false) can never enter
//   Drive (G-2). No override exists in D1.
// - No dead reckoning: progress only ever comes from real fixes
//   good enough to use (G-1). Between fixes the marker holds.
// - Hours are projections from his app logs, labeled as such; the
//   ELD is the legal record (F-014). F-013/F-015 stand - Drive's
//   hours are planning-grade and its copy says so.

import {
  haversineMiles,
  routeFractionOfPoint,
  type ClockState,
  type LatLng,
} from "./smart-path";
import type { RouteManeuver } from "@/services/integrations/routing";
import type { RouteCheckResponse } from "@/types/smart-path";

// ---------------------------------------------------------------------------
// Owner decisions (b) and (c) - built on the gate's RECOMMENDATIONS.
//
// The gate presented these as the owner's to rule and recommended:
// (b)(i) manual GO only, and (c) the G-7 minimal glance surface.
// The owner has not ruled otherwise, so D1 ships the recommended
// defaults - as named constants in this one place, so a different
// ruling is a one-line flip, not a refactor. Nothing else in Drive
// branches on un-named literals for these two decisions.

export const DRIVE_SETTINGS = {
  /** (b) How Drive starts: "manual-go" (recommended) - Drive only
   * ever starts from an explicit GO tap on a checked plan. */
  activation: "manual-go",
  /** (c) What shows while rolling: "glance" (recommended) - the
   * G-7 minimal surface; the full app sits behind "I'm parked". */
  rollingSurface: "glance",
  /** ELD coexistence (vision §9f): the compact coach layout is
   * offered when his ELD's nav is the one leading. */
  coachLayoutAvailable: true,
} as const;

/** Every numeric threshold the gate named, in one place (G-1/G-3/G-5/G-7). */
export const DRIVE_THRESHOLDS = {
  /** Fixes worse than this still move the marker (hollow) but are
   * excluded from progress, arrival, and missed-stop math (G-1). */
  goodFixMaxAccuracyM: 100,
  /** No usable fix for this long -> the GPS-lost banner (G-1). */
  gpsLostBannerSeconds: 30,
  /** GPS lost this long -> one spoken line, never repeated (G-1). */
  gpsLostSpokenSeconds: 5 * 60,
  /** Arrival fence radius - truck stops are big (G-3). */
  arrivalRadiusMiles: 200 / 1609.344,
  /** Arrival also needs speed under this, sustained (G-3)... */
  arrivalSpeedMph: 3,
  arrivalSpeedSustainSeconds: 30,
  /** ...or this much dwell inside the fence at any speed (G-3). */
  arrivalDwellSeconds: 45,
  /** Next-stop approach is spoken at this distance (G-6 #2). */
  approachMiles: 2,
  /** Along-route fraction passes a stop by more than this with no
   * arrival -> the stop is missed (G-3). */
  missedByMiles: 1,
  /** Above this GPS speed the rolling surface is the G-7 glance
   * surface; at or under it, the fuller Drive card shows (G-7). */
  rollingSpeedMph: 5,
  /** Stopped this long -> offer (never force) the full plan (G-7). */
  stoppedOfferSeconds: 30,
  /** A checkpoint younger than this offers Resume (G-5). */
  checkpointMaxAgeMs: 12 * 60 * 60_000,
  /** HOS cliff warnings fire at these minutes-left marks (G-6 #3). */
  cliffWarningMinutes: [60, 30] as const,
  /** Checkpoint writes are throttled to at most this cadence (G-5). */
  checkpointThrottleMs: 5_000,
  /** Camera/progress ignore fixes closer than this (G-5 battery). */
  minProgressMovementMiles: 10 / 1609.344,
} as const;

/** Copy the gate fixed in substance - kept verbatim so the surface
 * and the tests assert the same words (G-1/G-2/G-5). */
export const DRIVE_COPY = {
  noPlan:
    "No checked run yet. Plan it first — it takes a minute while you're parked.",
  permissionExplainer:
    "Drive Mode needs your location to put you on your route and time your stops. It only watches while Drive is open.",
  firstRun:
    "Keep this screen on and the phone plugged in. If you lock the phone, Drive pauses and picks back up when you return. It does not track you with the screen off.",
  carRouteRefusal:
    "This plan's route wasn't truck-checked — it came back as a car route. Drive Mode needs a truck-checked route. Re-check the run, or run this one on your ELD nav.",
  coverageCaveat:
    "This route was checked against the truck limits recorded in the map data. A road with no recorded limit reads as passable — the truck's own nav/ELD is the final word.",
  hoursSmallPrint:
    "Hours from your app logs — the ELD is the legal record. Route checked against recorded map limits only.",
  gpsLostBanner: "GPS signal lost — showing your last known spot",
  gpsLostSpoken: "Lost GPS. Keep following the last plan — I'll pick you back up.",
  permissionDenied:
    "Location is off for this site, so Drive can't start. You can turn it back on in the browser's site settings whenever you're ready — Drive won't ask again this session.",
} as const;

// ---------------------------------------------------------------------------
// The plan snapshot Drive consumes (built once, at GO, from a
// checked RouteCheckResponse; Drive never re-plans).

export type DriveStopKind =
  | "start"
  | "pickup"
  | "rest"
  | "fuel"
  | "food"
  | "workout"
  | "delivery";

export interface DriveStop {
  id: string;
  kind: DriveStopKind;
  name: string;
  point: LatLng;
  /** Fraction along the combined drive path (deadhead + loaded). */
  fraction: number;
  /** Same badge the Plan map shows (F1, S1, W1, A, B...). */
  badge: string;
  /** G-7 rolling badge text; null for the deadhead start. */
  lifeBadge: string | null;
  /** Workout stops carry their planned length (G-6 #5 speech). */
  durationMinutes: number | null;
  /** Workout anchor kind, for the "gym next door" line (G-6 #5). */
  placeKind: "gym" | "rest_area" | "parking" | "fuel_stop" | null;
}

export interface DriveTimelineSegment {
  kind: "drive" | "break" | "workout" | "sleep";
  label: string;
  minutes: number;
}

export interface DrivePlanSnapshot {
  /** (driver, load) session key per the design's future-proofing
   * note - today the driver half is the constant "driver". */
  key: string;
  loadId: string;
  originLabel: string;
  destinationLabel: string;
  provider: string;
  truckLegal: boolean;
  verdictStatus: RouteCheckResponse["verdict"]["status"];
  checkedAt: string;
  arrivalAt: string | null;
  assumedDriveMinutes: number;
  totalMiles: number;
  /** The path actually driven: deadhead geometry (if any) joined
   * to the loaded geometry, joint point de-duplicated. */
  geometry: LatLng[];
  stops: DriveStop[];
  /** Maneuvers remapped onto the combined path; [] when the
   * serving provider returned none - Drive then guides by
   * next stop only, and says so. */
  maneuvers: RouteManeuver[];
  clocks: ClockState | null;
  lifeLines: string[];
  timeline: DriveTimelineSegment[];
}

function remapManeuvers(
  maneuvers: RouteManeuver[] | undefined,
  legMiles: number,
  offsetMiles: number,
  totalMiles: number,
): RouteManeuver[] {
  if (!maneuvers || legMiles <= 0 || totalMiles <= 0) return [];
  return maneuvers.map((maneuver) => ({
    instruction: maneuver.instruction,
    distanceMiles: maneuver.distanceMiles,
    atFraction: (offsetMiles + maneuver.atFraction * legMiles) / totalMiles,
  }));
}

const STOP_ORDER: Record<DriveStopKind, number> = {
  start: 0,
  pickup: 1,
  fuel: 2,
  food: 2,
  workout: 2,
  rest: 2,
  delivery: 3,
};

export function buildDrivePlan(
  result: RouteCheckResponse,
  checkedAt: Date,
): DrivePlanSnapshot {
  const deadhead = result.deadhead;
  const deadheadMiles = deadhead ? deadhead.distanceMiles : 0;
  const routeMiles = result.route.distanceMiles;
  const totalMiles = deadheadMiles + routeMiles;

  const geometry: LatLng[] = deadhead
    ? [
        ...deadhead.geometry,
        ...(deadhead.geometry.length > 0 &&
        result.route.geometry.length > 0 &&
        deadhead.geometry[deadhead.geometry.length - 1]!.lat ===
          result.route.geometry[0]!.lat &&
        deadhead.geometry[deadhead.geometry.length - 1]!.lng ===
          result.route.geometry[0]!.lng
          ? result.route.geometry.slice(1)
          : result.route.geometry),
      ]
    : result.route.geometry;

  const toCombined = (mainFraction: number) =>
    totalMiles > 0 ? (deadheadMiles + mainFraction * routeMiles) / totalMiles : 0;

  const stops: DriveStop[] = [];
  if (deadhead) {
    stops.push({
      id: "start",
      kind: "start",
      name: deadhead.startLabel,
      point: deadhead.startPoint,
      fraction: 0,
      badge: "START",
      lifeBadge: null,
      durationMinutes: null,
      placeKind: null,
    });
  }
  stops.push({
    id: "origin",
    kind: "pickup",
    name: result.load.origin,
    point: result.route.originPoint,
    fraction: totalMiles > 0 ? deadheadMiles / totalMiles : 0,
    badge: "A",
    lifeBadge: "Pickup",
    durationMinutes: null,
    placeKind: null,
  });

  const fuel = result.fuel.candidates[0];
  if (fuel) {
    stops.push({
      id: fuel.id,
      kind: "fuel",
      name: fuel.name,
      point: { lat: fuel.lat, lng: fuel.lng },
      fraction: toCombined(routeFractionOfPoint(fuel, result.route.geometry)),
      badge: "F1",
      lifeBadge: "Fuel",
      durationMinutes: null,
      placeKind: null,
    });
  }

  result.food.stops.forEach((stop, i) => {
    stops.push({
      id: stop.id,
      kind: "food",
      name: stop.name,
      point: { lat: stop.lat, lng: stop.lng },
      fraction: toCombined(routeFractionOfPoint(stop, result.route.geometry)),
      badge: `E${i + 1}`,
      lifeBadge: "Food",
      durationMinutes: null,
      placeKind: null,
    });
  });

  // Rests: the service already computed their points and their
  // fractionOfRoute is a fraction of the COMBINED route (P1-7).
  (result.plan?.rests ?? []).forEach((rest, i) => {
    if (!rest.point) return;
    stops.push({
      id: `rest-${i}`,
      kind: "rest",
      name: "Sleep stop",
      point: rest.point,
      fraction: rest.fractionOfRoute,
      badge: `S${i + 1}`,
      lifeBadge: "Sleep",
      durationMinutes: null,
      placeKind: null,
    });
  });

  const workout = result.plan?.workout;
  if (workout?.placed && workout.point) {
    stops.push({
      id: "workout",
      kind: "workout",
      name: workout.placeName ?? "Workout stop",
      point: workout.point,
      fraction: toCombined(routeFractionOfPoint(workout.point, result.route.geometry)),
      badge: "W1",
      lifeBadge: `Workout ${workout.durationMinutes}m`,
      durationMinutes: workout.durationMinutes,
      placeKind: workout.placeKind,
    });
  }

  stops.push({
    id: "destination",
    kind: "delivery",
    name: result.load.destination,
    point: result.route.destinationPoint,
    fraction: 1,
    badge: "B",
    lifeBadge: "Delivery",
    durationMinutes: null,
    placeKind: null,
  });

  stops.sort(
    (a, b) => a.fraction - b.fraction || STOP_ORDER[a.kind] - STOP_ORDER[b.kind],
  );

  const maneuvers = [
    ...remapManeuvers(deadhead?.maneuvers, deadheadMiles, 0, totalMiles),
    ...remapManeuvers(result.route.maneuvers, routeMiles, deadheadMiles, totalMiles),
  ].sort((a, b) => a.atFraction - b.atFraction);

  const timeline: DriveTimelineSegment[] = [];
  const plan = result.plan;
  timeline.push({
    kind: "drive",
    label: "Driving",
    minutes: result.verdict.assumedDriveMinutes,
  });
  if (plan) {
    const breakMinutes = plan.breaks
      .filter((b) => b.kind === "break")
      .reduce((sum, b) => sum + b.durationMinutes, 0);
    if (breakMinutes > 0) {
      timeline.push({ kind: "break", label: "Breaks", minutes: breakMinutes });
    }
    if (plan.workout?.placed) {
      timeline.push({
        kind: "workout",
        label: "Workout",
        minutes: plan.workout.durationMinutes,
      });
    }
    if (plan.rests.length > 0) {
      timeline.push({
        kind: "sleep",
        label: `Sleep × ${plan.rests.length}`,
        minutes: plan.rests.length * 10 * 60,
      });
    }
  }

  return {
    key: `driver:${result.load.id}`,
    loadId: result.load.id,
    originLabel: result.load.origin,
    destinationLabel: result.load.destination,
    provider: result.route.provider,
    truckLegal: result.route.truckLegal,
    verdictStatus: result.verdict.status,
    checkedAt: checkedAt.toISOString(),
    arrivalAt: result.plan?.arrivalAt ?? null,
    assumedDriveMinutes: result.verdict.assumedDriveMinutes,
    totalMiles,
    geometry,
    stops,
    maneuvers,
    clocks: result.clocks ?? null,
    lifeLines: result.verdict.lifeLines,
    timeline,
  };
}

/** The G-2 hard gate, as one testable decision. */
export function driveGate(
  plan: DrivePlanSnapshot | null,
): { ok: true } | { ok: false; reason: "no-plan" | "car-route"; copy: string } {
  if (!plan) return { ok: false, reason: "no-plan", copy: DRIVE_COPY.noPlan };
  if (!plan.truckLegal) {
    return { ok: false, reason: "car-route", copy: DRIVE_COPY.carRouteRefusal };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The session: one checked plan plus what the road has done to it.
// evaluateFix is the whole rolling brain - pure, so a scripted run
// of fixes proves every spoken event fires exactly once (G-6).

export interface DriveFix {
  point: LatLng;
  /** Meters. Fixes worse than the G-1 line move the marker only. */
  accuracyM: number;
  speedMph: number | null;
  headingDeg: number | null;
  atMs: number;
}

/**
 * Along-route fraction of a point, projected onto the nearest
 * SEGMENT and interpolated within it. Drive's progress math needs
 * finer resolution than the shared vertex approximation in
 * lib/smart-path (routeFractionOfPoint, design §8.1): with sparse
 * geometry a vertex snap can jump a fix past a stop and swallow
 * both its approach call and its miss. Stop PLACEMENT keeps the
 * §8.1 helper so Drive and Plan agree on where stops sit; only
 * live progress uses this.
 */
export function fractionAlongRoute(point: LatLng, geometry: LatLng[]): number {
  if (geometry.length < 2) return 0;
  const cumulative: number[] = [0];
  for (let i = 1; i < geometry.length; i++) {
    cumulative.push(cumulative[i - 1]! + haversineMiles(geometry[i - 1]!, geometry[i]!));
  }
  const total = cumulative[cumulative.length - 1] || 1;
  const milesPerDegLat = 69.09;
  let bestAlong = 0;
  let bestPerp = Number.POSITIVE_INFINITY;
  for (let i = 1; i < geometry.length; i++) {
    const a = geometry[i - 1]!;
    const b = geometry[i]!;
    // Local flat frame (miles) around the segment - the right
    // scale for picking the nearest segment and the ratio along it.
    const kx = milesPerDegLat * Math.cos((a.lat * Math.PI) / 180);
    const ax = a.lng * kx;
    const ay = a.lat * milesPerDegLat;
    const bx = b.lng * kx;
    const by = b.lat * milesPerDegLat;
    const px = point.lng * kx;
    const py = point.lat * milesPerDegLat;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t =
      lenSq === 0
        ? 0
        : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const perp = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (perp < bestPerp) {
      bestPerp = perp;
      bestAlong = cumulative[i - 1]! + t * (cumulative[i]! - cumulative[i - 1]!);
    }
  }
  return bestAlong / total;
}

export type DriveStopStatus = "pending" | "arrived" | "skipped" | "missed";

export interface DriveSession {
  planKey: string;
  startedAtMs: number;
  stopStatus: DriveStopStatus[];
  nextStopIndex: number;
  /** Furthest along-route fraction from a usable fix. Monotonic:
   * Drive never un-drives a mile it actually measured (G-1). */
  progressFraction: number;
  lastFix: DriveFix | null;
  lastGoodFixAtMs: number | null;
  /** Inside the next stop's fence since (arrival math, G-3). */
  fenceSinceMs: number | null;
  /** Slow (< arrival speed) inside the fence since (G-3). */
  slowSinceMs: number | null;
  /** Continuous dwell under way - a 30+ minute dwell is a break,
   * and the projected break clock restarts there (HOS rule). */
  dwellSinceMs: number | null;
  /** Driving minutes accumulated at the last break reset. */
  breakAnchorDrivingMinutes: number;
  breakResetDwellKey: number | null;
  /** Speed under the rolling line since (stopped offer, G-7). */
  stoppedSinceMs: number | null;
  stoppedOfferShown: boolean;
  /** Minutes actually driven this session (speed >= 2 mph spans). */
  drivingMinutes: number;
  /** Once-only speech flags (G-6: every event speaks exactly once). */
  approachSpoken: number[];
  cliffSpoken: string[];
  gpsBannerOn: boolean;
  gpsLostSpokenDone: boolean;
}

export function newDriveSession(plan: DrivePlanSnapshot, startedAtMs: number): DriveSession {
  return {
    planKey: plan.key,
    startedAtMs,
    stopStatus: plan.stops.map(() => "pending" as const),
    nextStopIndex: 0,
    progressFraction: 0,
    lastFix: null,
    lastGoodFixAtMs: null,
    fenceSinceMs: null,
    slowSinceMs: null,
    dwellSinceMs: null,
    breakAnchorDrivingMinutes: 0,
    breakResetDwellKey: null,
    stoppedSinceMs: null,
    stoppedOfferShown: false,
    drivingMinutes: 0,
    approachSpoken: [],
    cliffSpoken: [],
    gpsBannerOn: false,
    gpsLostSpokenDone: false,
  };
}

export type DriveEvent =
  | { type: "approach"; stopIndex: number }
  | { type: "arrived"; stopIndex: number }
  | { type: "missed"; stopIndex: number }
  | { type: "gps-banner"; lost: boolean }
  | { type: "gps-lost-spoken" }
  | { type: "gps-recovered"; stopIndex: number }
  | { type: "cliff"; clock: "break" | "window"; minutesLeft: 60 | 30 }
  | { type: "stopped-offer" };

export interface ClockProjection {
  driveLeftMin: number;
  breakDueInMin: number;
  windowCloseInMin: number;
  fromLogs: boolean;
}

/**
 * HOS clocks projected forward from the check's clocks (G-6 #3).
 * The 14-hour window burns in wall-clock time from the check; the
 * break clock burns with driving time and restarts after a real
 * 30-minute dwell. Projections, labeled as such wherever shown -
 * the ELD is the legal record (F-014).
 */
export function projectClocks(
  plan: DrivePlanSnapshot,
  session: DriveSession,
  nowMs: number,
): ClockProjection | null {
  const clocks = plan.clocks;
  if (!clocks) return null;
  const wallMinutesSinceCheck = Math.max(
    0,
    (nowMs - Date.parse(plan.checkedAt)) / 60_000,
  );
  const drivingSinceBreak = session.drivingMinutes - session.breakAnchorDrivingMinutes;
  return {
    driveLeftMin: Math.max(0, clocks.driveLeftMin - session.drivingMinutes),
    breakDueInMin: clocks.breakLeftMin - drivingSinceBreak,
    windowCloseInMin: clocks.windowLeftMin - wallMinutesSinceCheck,
    fromLogs: clocks.fromLogs,
  };
}

function advanceNextStop(session: DriveSession, plan: DrivePlanSnapshot): void {
  let index = session.nextStopIndex + 1;
  while (index < plan.stops.length && session.stopStatus[index] !== "pending") {
    index += 1;
  }
  session.nextStopIndex = index;
  session.fenceSinceMs = null;
  session.slowSinceMs = null;
}

/**
 * Feeds one fix (or a null tick - the page's 1 s timer, which is
 * how time-based events like GPS loss fire without a fix) into the
 * session. Mutates and returns the session for the caller's
 * convenience; events are the once-only occurrences this tick
 * produced, in speaking order.
 */
export function evaluateFix(
  session: DriveSession,
  plan: DrivePlanSnapshot,
  fix: DriveFix | null,
  nowMs: number,
): { session: DriveSession; events: DriveEvent[] } {
  const events: DriveEvent[] = [];
  const next = session;

  if (fix) {
    next.lastFix = fix;
    const usable = fix.accuracyM <= DRIVE_THRESHOLDS.goodFixMaxAccuracyM;
    if (usable) {
      // Recovery (G-1): a usable fix after a loss episode speaks
      // once and clears the banner.
      if (next.gpsBannerOn) {
        next.gpsBannerOn = false;
        next.gpsLostSpokenDone = false;
        events.push({ type: "gps-banner", lost: false });
        events.push({ type: "gps-recovered", stopIndex: next.nextStopIndex });
      }
      const previousGoodAt = next.lastGoodFixAtMs;
      next.lastGoodFixAtMs = nowMs;

      // Driving accumulation: credit the span since the last good
      // fix when this fix says we're moving, capped per interval
      // so a long signal gap can't mint hours out of thin air.
      if (previousGoodAt !== null && fix.speedMph !== null && fix.speedMph >= 2) {
        const spanMinutes = Math.min(10, Math.max(0, (nowMs - previousGoodAt) / 60_000));
        next.drivingMinutes += spanMinutes;
      }

      const fraction = fractionAlongRoute(fix.point, plan.geometry);
      if (fraction > next.progressFraction) {
        next.progressFraction = fraction;
      }

      // Dwell: parked-ish fixes start/continue a dwell; a dwell of
      // 30+ minutes is an HOS break, so the projected break clock
      // restarts from here - once per dwell.
      if (fix.speedMph !== null && fix.speedMph < 2) {
        if (next.dwellSinceMs === null) next.dwellSinceMs = nowMs;
        if (
          nowMs - next.dwellSinceMs >= 30 * 60_000 &&
          next.breakResetDwellKey !== next.dwellSinceMs
        ) {
          next.breakResetDwellKey = next.dwellSinceMs;
          next.breakAnchorDrivingMinutes = next.drivingMinutes;
        }
      } else if (fix.speedMph !== null) {
        next.dwellSinceMs = null;
      }

      // Stopped offer (G-7): under the rolling speed, sustained,
      // offers the full plan - once per stop episode.
      if (fix.speedMph !== null && fix.speedMph <= DRIVE_THRESHOLDS.rollingSpeedMph) {
        if (next.stoppedSinceMs === null) next.stoppedSinceMs = nowMs;
        if (
          nowMs - next.stoppedSinceMs >= DRIVE_THRESHOLDS.stoppedOfferSeconds * 1000 &&
          !next.stoppedOfferShown
        ) {
          next.stoppedOfferShown = true;
          events.push({ type: "stopped-offer" });
        }
      } else if (fix.speedMph !== null) {
        next.stoppedSinceMs = null;
        next.stoppedOfferShown = false;
      }

      // The next stop: approach, arrival, missed (G-3/G-6).
      const stopIndex = next.nextStopIndex;
      const stop = plan.stops[stopIndex];
      if (stop && next.stopStatus[stopIndex] === "pending") {
        const milesToStop = Math.max(0, (stop.fraction - next.progressFraction) * plan.totalMiles);
        const distanceToStop = haversineMiles(fix.point, stop.point);

        if (
          milesToStop <= DRIVE_THRESHOLDS.approachMiles &&
          milesToStop > 0 &&
          !next.approachSpoken.includes(stopIndex)
        ) {
          next.approachSpoken.push(stopIndex);
          events.push({ type: "approach", stopIndex });
        }

        if (distanceToStop <= DRIVE_THRESHOLDS.arrivalRadiusMiles) {
          if (next.fenceSinceMs === null) next.fenceSinceMs = nowMs;
          if (fix.speedMph !== null && fix.speedMph < DRIVE_THRESHOLDS.arrivalSpeedMph) {
            if (next.slowSinceMs === null) next.slowSinceMs = nowMs;
          } else if (fix.speedMph !== null) {
            next.slowSinceMs = null;
          }
          const slowArrival =
            next.slowSinceMs !== null &&
            nowMs - next.slowSinceMs >= DRIVE_THRESHOLDS.arrivalSpeedSustainSeconds * 1000;
          const dwellArrival =
            nowMs - next.fenceSinceMs >= DRIVE_THRESHOLDS.arrivalDwellSeconds * 1000;
          if (slowArrival || dwellArrival) {
            next.stopStatus[stopIndex] = "arrived";
            events.push({ type: "arrived", stopIndex });
            advanceNextStop(next, plan);
          }
        } else {
          next.fenceSinceMs = null;
          next.slowSinceMs = null;
          const missedBy =
            (next.progressFraction - stop.fraction) * plan.totalMiles;
          if (missedBy > DRIVE_THRESHOLDS.missedByMiles) {
            next.stopStatus[stopIndex] = "missed";
            events.push({ type: "missed", stopIndex });
            advanceNextStop(next, plan);
          }
        }
      }
    }
  }

  // GPS loss (G-1): time-based, so it fires on ticks too. No dead
  // reckoning - nothing else in the session moves without a fix.
  if (next.lastGoodFixAtMs !== null) {
    const lostForSeconds = (nowMs - next.lastGoodFixAtMs) / 1000;
    if (lostForSeconds >= DRIVE_THRESHOLDS.gpsLostBannerSeconds && !next.gpsBannerOn) {
      next.gpsBannerOn = true;
      events.push({ type: "gps-banner", lost: true });
    }
    if (
      lostForSeconds >= DRIVE_THRESHOLDS.gpsLostSpokenSeconds &&
      next.gpsBannerOn &&
      !next.gpsLostSpokenDone
    ) {
      next.gpsLostSpokenDone = true;
      events.push({ type: "gps-lost-spoken" });
    }
  }

  // HOS cliffs (G-6 #3): each threshold speaks exactly once.
  const projection = projectClocks(plan, next, nowMs);
  if (projection) {
    for (const minutes of DRIVE_THRESHOLDS.cliffWarningMinutes) {
      for (const clock of ["break", "window"] as const) {
        const left = clock === "break" ? projection.breakDueInMin : projection.windowCloseInMin;
        const key = `${clock}-${minutes}`;
        if (left <= minutes && left > 0 && !next.cliffSpoken.includes(key)) {
          next.cliffSpoken.push(key);
          events.push({ type: "cliff", clock, minutesLeft: minutes });
        }
      }
    }
  }

  return { session: next, events };
}

/** Skip (G-3): one tap, marked, spoken once by the caller. */
export function skipNextStop(
  session: DriveSession,
  plan: DrivePlanSnapshot,
): { session: DriveSession; skippedIndex: number } {
  const skippedIndex = session.nextStopIndex;
  if (skippedIndex < plan.stops.length && session.stopStatus[skippedIndex] === "pending") {
    session.stopStatus[skippedIndex] = "skipped";
    advanceNextStop(session, plan);
  }
  return { session, skippedIndex };
}

/** The next maneuver at or ahead of progress, with its distance. */
export function nextManeuver(
  plan: DrivePlanSnapshot,
  progressFraction: number,
): { maneuver: RouteManeuver; milesAway: number } | null {
  for (const maneuver of plan.maneuvers) {
    if (maneuver.atFraction >= progressFraction - 1e-9) {
      return {
        maneuver,
        milesAway: Math.max(0, (maneuver.atFraction - progressFraction) * plan.totalMiles),
      };
    }
  }
  return null;
}

/** Coarse direction for the glance arrow, from instruction text. */
export function maneuverDirection(instruction: string): "left" | "right" | "straight" | "uturn" | "arrive" {
  const text = instruction.toLowerCase();
  if (text.includes("u-turn") || text.includes("uturn")) return "uturn";
  if (text.includes("arrive") || text.includes("destination")) return "arrive";
  if (text.includes("left")) return "left";
  if (text.includes("right")) return "right";
  return "straight";
}

/** ETA in minutes to a stop: live speed when it's meaningful,
 * otherwise the plan's own pace. A projection either way. */
export function etaMinutesToStop(
  plan: DrivePlanSnapshot,
  session: DriveSession,
  stop: DriveStop,
  fix: DriveFix | null,
): number | null {
  const milesLeft = Math.max(0, (stop.fraction - session.progressFraction) * plan.totalMiles);
  if (milesLeft === 0) return 0;
  if (fix && fix.speedMph !== null && fix.speedMph >= 10) {
    return (milesLeft / fix.speedMph) * 60;
  }
  if (plan.assumedDriveMinutes > 0 && plan.totalMiles > 0) {
    const paceMph = plan.totalMiles / (plan.assumedDriveMinutes / 60);
    return (milesLeft / paceMph) * 60;
  }
  return null;
}

// Spoken text, end-of-drive review and persistence live in their own files
// (file decomposition); re-exported so every existing import still resolves.
export * from "./drive-lines";
export * from "./drive-review";
