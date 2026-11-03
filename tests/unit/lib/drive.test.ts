import { describe, expect, it } from "vitest";
import {
  DRIVE_COPY,
  approachSpeech,
  buildDrivePlan,
  cliffSpeech,
  driveGate,
  driveReviewLines,
  etaMinutesToStop,
  evaluateFix,
  goSummarySpeech,
  maneuverDirection,
  nextManeuver,
  newDriveSession,
  parseActivePlan,
  parseCheckpoint,
  projectClocks,
  serializeActivePlan,
  serializeCheckpoint,
  skipNextStop,
  skipSpeech,
  speechForEvent,
  type DriveFix,
  type DrivePlanSnapshot,
} from "@/lib/drive";
import type { LatLng } from "@/lib/smart-path";
import type { RouteCheckResponse } from "@/types/smart-path";

const CHECKED_AT = new Date("2026-11-02T15:00:00.000Z");
const T0 = CHECKED_AT.getTime();

function linePoints(): LatLng[] {
  return Array.from({ length: 11 }, (_, i) => ({ lat: 28 + i * 0.5, lng: -81.7 }));
}

function pointAt(fraction: number): LatLng {
  return { lat: 28 + fraction * 5, lng: -81.7 };
}

function makeResult(overrides: Partial<RouteCheckResponse> = {}): RouteCheckResponse {
  const geometry = linePoints();
  const base: RouteCheckResponse = {
    load: { id: "load-1", origin: "Orlando, FL", destination: "Atlanta, GA", status: "assigned" },
    route: {
      provider: "valhalla",
      truckLegal: true,
      distanceMiles: 100,
      providerDurationMinutes: 120,
      geometry,
      originPoint: geometry[0]!,
      destinationPoint: geometry[geometry.length - 1]!,
      maneuvers: [
        { instruction: "Head north on I-75.", distanceMiles: 40, atFraction: 0.02 },
        { instruction: "Turn right onto Peachtree St.", distanceMiles: 2, atFraction: 0.9 },
      ],
    },
    clocks: {
      driveLeftMin: 600,
      windowLeftMin: 800,
      breakLeftMin: 400,
      weekLeftMin: 3000,
      fromLogs: true,
    },
    verdict: {
      status: "on_time",
      assumedDriveMinutes: 120,
      driveTimeBasis: "provider",
      legalLines: [],
      restedLines: [],
      lifeLines: [],
      paidLines: [],
      tradeoffLines: [],
      makeItDepartureAt: null,
      leaveStartByAt: null,
    },
    plan: {
      arrivalAt: "2026-11-02T17:00:00.000Z",
      totalElapsedMinutes: 120,
      breaks: [],
      rests: [],
      workout: null,
    },
    deadhead: null,
    fuel: {
      assumptions: {
        gallonsToBuy: 50,
        avgMpg: 6.5,
        valueOfTimeCentsPerHour: 2500,
        stopMinutes: 20,
        baselinePriceCents: null,
      },
      candidates: [
        {
          id: "fuel-1",
          name: "Pilot — Wildwood",
          lat: pointAt(0.3).lat,
          lng: -81.7,
          pricePerGallonCents: 389,
          source: "history",
          detourMiles: 0.4,
          pumpCostCents: 19450,
          detourCostCents: 300,
          effectiveCostCents: 19750,
          savingsVsBaselineCents: null,
          usedEstimate: false,
        },
      ],
      unavailableReason: null,
    },
    food: { mode: "grocery", groceryPlan: null, stops: [], suppressedByFast: [], lines: [], unavailableReason: null },
    warnings: [],
  };
  return { ...base, ...overrides };
}

function makePlan(overrides: Partial<RouteCheckResponse> = {}): DrivePlanSnapshot {
  return buildDrivePlan(makeResult(overrides), CHECKED_AT);
}

function fix(fraction: number, atMs: number, speedMph = 55, accuracyM = 15): DriveFix {
  return { point: pointAt(fraction), accuracyM, speedMph, headingDeg: 0, atMs };
}

describe("buildDrivePlan", () => {
  it("orders stops pickup → fuel → delivery with no deadhead", () => {
    const plan = makePlan();
    expect(plan.stops.map((s) => s.kind)).toEqual(["pickup", "fuel", "delivery"]);
    expect(plan.stops[0]!.fraction).toBe(0);
    expect(plan.stops[1]!.fraction).toBeCloseTo(0.3, 5);
    expect(plan.stops[2]!.fraction).toBe(1);
    expect(plan.totalMiles).toBe(100);
    expect(plan.key).toBe("driver:load-1");
  });

  it("puts the deadhead first: start stop, pickup at the deadhead share", () => {
    const geometry = linePoints();
    const plan = makePlan({
      deadhead: {
        startLabel: "Yard — Jacksonville",
        startPoint: pointAt(-0.2),
        distanceMiles: 60,
        providerDurationMinutes: 70,
        provider: "valhalla",
        truckLegal: true,
        geometry: [pointAt(-0.2), geometry[0]!],
        leaveByAt: "2026-11-02T13:50:00.000Z",
        pickupArrivalAt: "2026-11-02T15:00:00.000Z",
        waitMinutesAtPickup: 0,
      },
      route: { ...makeResult().route, distanceMiles: 300 },
    });
    expect(plan.stops[0]!.kind).toBe("start");
    expect(plan.stops[1]!.kind).toBe("pickup");
    expect(plan.stops[1]!.fraction).toBeCloseTo(60 / 360, 5);
    expect(plan.totalMiles).toBe(360);
    expect(plan.stops[plan.stops.length - 1]!.kind).toBe("delivery");
  });

  it("keeps a rest stop's combined-route fraction untouched (P1-7)", () => {
    const plan = makePlan({
      plan: {
        arrivalAt: null,
        totalElapsedMinutes: 0,
        breaks: [],
        rests: [
          {
            startAt: "2026-11-02T23:00:00.000Z",
            endAt: "2026-11-03T09:00:00.000Z",
            distanceMilesFromOrigin: 62,
            fractionOfRoute: 0.62,
            startHourEastern: 23,
            point: pointAt(0.62),
          },
        ],
        workout: null,
      },
    });
    const rest = plan.stops.find((s) => s.kind === "rest");
    expect(rest?.fraction).toBe(0.62);
    expect(rest?.lifeBadge).toBe("Sleep");
  });

  it("carries the workout stop with its duration and place kind", () => {
    const plan = makePlan({
      plan: {
        arrivalAt: null,
        totalElapsedMinutes: 0,
        breaks: [],
        rests: [],
        workout: {
          placed: true,
          startAt: null,
          durationMinutes: 60,
          placeName: "Anytime Fitness",
          placeKind: "gym",
          point: pointAt(0.5),
          note: "",
        },
      },
    });
    const workout = plan.stops.find((s) => s.kind === "workout");
    expect(workout?.durationMinutes).toBe(60);
    expect(workout?.placeKind).toBe("gym");
    expect(workout?.fraction).toBeCloseTo(0.5, 5);
  });

  it("builds a day timeline with drive / workout / sleep segments", () => {
    const plan = makePlan({
      plan: {
        arrivalAt: null,
        totalElapsedMinutes: 0,
        breaks: [],
        rests: [
          {
            startAt: "2026-11-02T23:00:00.000Z",
            endAt: "2026-11-03T09:00:00.000Z",
            distanceMilesFromOrigin: 62,
            fractionOfRoute: 0.62,
            startHourEastern: 23,
            point: pointAt(0.62),
          },
        ],
        workout: {
          placed: true,
          startAt: null,
          durationMinutes: 45,
          placeName: "Gym",
          placeKind: "gym",
          point: pointAt(0.5),
          note: "",
        },
      },
    });
    const kinds = plan.timeline.map((s) => s.kind);
    expect(kinds).toContain("drive");
    expect(kinds).toContain("workout");
    expect(kinds[kinds.length - 1]).toBe("sleep");
  });
});

describe("driveGate (G-2)", () => {
  it("refuses when there is no checked plan", () => {
    const gate = driveGate(null);
    expect(gate.ok).toBe(false);
    if (!gate.ok) { expect(gate.reason).toBe("no-plan"); expect(gate.copy).toBe(DRIVE_COPY.noPlan); }
  });

  it("refuses a car-profile plan with the design's refusal copy", () => {
    const plan = makePlan({
      route: { ...makeResult().route, truckLegal: false, provider: "osrm" },
    });
    const gate = driveGate(plan);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.copy).toContain("car route");
      expect(gate.copy).toBe(DRIVE_COPY.carRouteRefusal);
    }
  });

  it("admits a truck-checked plan", () => {
    expect(driveGate(makePlan()).ok).toBe(true);
  });
});

describe("evaluateFix — stop progression (G-3)", () => {
  it("speaks approach once inside 2 miles of the next stop", () => {
    const plan = makePlan();
    const session = newDriveSession(plan, T0);
    // Start at the pickup: arrive it by dwelling at fraction 0.
    evaluateFix(session, plan, fix(0, T0, 0), T0);
    const arrived = evaluateFix(session, plan, fix(0, T0 + 50_000, 0), T0 + 50_000);
    expect(arrived.events.some((e) => e.type === "arrived" && e.stopIndex === 0)).toBe(true);
    // Now the fuel stop at 0.30 is next; 0.285 is 1.5 miles out.
    const approach = evaluateFix(session, plan, fix(0.285, T0 + 60_000), T0 + 60_000);
    expect(approach.events.filter((e) => e.type === "approach")).toHaveLength(1);
    const again = evaluateFix(session, plan, fix(0.29, T0 + 70_000), T0 + 70_000);
    expect(again.events.some((e) => e.type === "approach")).toBe(false);
  });

  it("arrives by dwell: 45s inside the fence even while rolling slowly through it", () => {
    const plan = makePlan();
    const session = newDriveSession(plan, T0);
    session.nextStopIndex = 1;
    evaluateFix(session, plan, fix(0.3, T0, 25), T0);
    const mid = evaluateFix(session, plan, fix(0.3, T0 + 20_000, 25), T0 + 20_000);
    expect(mid.events.some((e) => e.type === "arrived")).toBe(false);
    const done = evaluateFix(session, plan, fix(0.3, T0 + 50_000, 25), T0 + 50_000);
    expect(done.events.some((e) => e.type === "arrived" && e.stopIndex === 1)).toBe(true);
    expect(session.stopStatus[1]).toBe("arrived");
  });

  it("arrives by slow sustain: under 3 mph for 30s inside the fence", () => {
    const plan = makePlan();
    const session = newDriveSession(plan, T0);
    session.nextStopIndex = 1;
    evaluateFix(session, plan, fix(0.3, T0, 2), T0);
    const done = evaluateFix(session, plan, fix(0.3, T0 + 35_000, 2), T0 + 35_000);
    expect(done.events.some((e) => e.type === "arrived")).toBe(true);
  });

  it("does NOT arrive on a drive-past; the stop is missed once, 1 mile past", () => {
    const plan = makePlan();
    const session = newDriveSession(plan, T0);
    session.nextStopIndex = 1;
    evaluateFix(session, plan, fix(0.28, T0, 60), T0);
    const past = evaluateFix(session, plan, fix(0.315, T0 + 9_000, 60), T0 + 9_000);
    expect(past.events.some((e) => e.type === "arrived")).toBe(false);
    expect(past.events.some((e) => e.type === "missed" && e.stopIndex === 1)).toBe(true);
    expect(session.stopStatus[1]).toBe("missed");
    expect(session.nextStopIndex).toBe(2);
  });

  it("a poor fix moves nothing: no progress, no approach, no arrival math", () => {
    const plan = makePlan();
    const session = newDriveSession(plan, T0);
    const result = evaluateFix(session, plan, fix(0.29, T0, 55, 250), T0);
    expect(result.events).toHaveLength(0);
    expect(session.progressFraction).toBe(0);
    expect(session.lastFix?.accuracyM).toBe(250);
  });
});

describe("evaluateFix — GPS honesty (G-1)", () => {
  it("banner at 30s without a usable fix, one spoken line at 5 min, never repeated in the episode", () => {
    const plan = makePlan();
    const session = newDriveSession(plan, T0);
    evaluateFix(session, plan, fix(0.05, T0), T0);
    const banner = evaluateFix(session, plan, null, T0 + 31_000);
    expect(banner.events).toContainEqual({ type: "gps-banner", lost: true });
    const spoken = evaluateFix(session, plan, null, T0 + 301_000);
    expect(spoken.events).toContainEqual({ type: "gps-lost-spoken" });
    const later = evaluateFix(session, plan, null, T0 + 600_000);
    expect(later.events.some((e) => e.type === "gps-lost-spoken")).toBe(false);
    expect(later.events.some((e) => e.type === "gps-banner")).toBe(false);
    expect(session.gpsBannerOn).toBe(true);
  });

  it("recovery speaks once and clears the banner", () => {
    const plan = makePlan();
    const session = newDriveSession(plan, T0);
    evaluateFix(session, plan, fix(0.05, T0), T0);
    evaluateFix(session, plan, null, T0 + 40_000);
    const back = evaluateFix(session, plan, fix(0.06, T0 + 50_000), T0 + 50_000);
    expect(back.events).toContainEqual({ type: "gps-banner", lost: false });
    expect(back.events.some((e) => e.type === "gps-recovered")).toBe(true);
    expect(session.gpsBannerOn).toBe(false);
    const speech = speechForEvent(back.events.find((e) => e.type === "gps-recovered")!, plan, session);
    expect(speech).toContain("Back on you");
  });
});

describe("evaluateFix — HOS cliff projections (G-6)", () => {
  it("fires the 60-minute window cliff once, labeled a projection in speech", () => {
    const plan = makePlan({
      clocks: { driveLeftMin: 600, windowLeftMin: 59, breakLeftMin: 400, weekLeftMin: 3000, fromLogs: true },
    });
    const session = newDriveSession(plan, T0);
    const first = evaluateFix(session, plan, fix(0.02, T0 + 60_000, 55), T0 + 60_000);
    const cliffs = first.events.filter((e) => e.type === "cliff");
    expect(cliffs).toHaveLength(1);
    expect(cliffs[0]).toMatchObject({ clock: "window", minutesLeft: 60 });
    const second = evaluateFix(session, plan, fix(0.03, T0 + 120_000, 55), T0 + 120_000);
    expect(second.events.some((e) => e.type === "cliff")).toBe(false);
    expect(cliffSpeech("window", 60)).toContain("by projection");
  });

  it("projectClocks burns the window in wall time and the break clock in driving time", () => {
    const plan = makePlan();
    const session = newDriveSession(plan, T0);
    session.drivingMinutes = 30;
    const projection = projectClocks(plan, session, T0 + 10 * 60_000);
    expect(projection?.windowCloseInMin).toBe(800 - 10);
    expect(projection?.breakDueInMin).toBe(400 - 30);
    expect(projection?.driveLeftMin).toBe(600 - 30);
  });
});

describe("skip, maneuvers, ETA", () => {
  it("skip advances to the next stop and the speech names it", () => {
    const plan = makePlan();
    const session = newDriveSession(plan, T0);
    const { skippedIndex } = skipNextStop(session, plan);
    expect(skippedIndex).toBe(0);
    expect(session.stopStatus[0]).toBe("skipped");
    expect(session.nextStopIndex).toBe(1);
    expect(skipSpeech(plan.stops[0]!, plan.stops[1]!)).toContain("Skipped. Next is");
  });

  it("nextManeuver follows progress along the plan", () => {
    const plan = makePlan();
    const session = newDriveSession(plan, T0);
    expect(nextManeuver(plan, 0)?.maneuver.instruction).toContain("Head north");
    expect(nextManeuver(plan, 0.5)?.maneuver.instruction).toContain("Peachtree");
    expect(nextManeuver(plan, 0.5)?.milesAway).toBeCloseTo(40, 5);
    expect(nextManeuver(plan, 0.95)).toBeNull();
  });

  it("maneuverDirection reads the turn out of the instruction", () => {
    expect(maneuverDirection("Turn right onto Peachtree St.")).toBe("right");
    expect(maneuverDirection("Turn left onto Main St.")).toBe("left");
    expect(maneuverDirection("Continue straight for 5 miles.")).toBe("straight");
    expect(maneuverDirection("Make a U-turn.")).toBe("uturn");
    expect(maneuverDirection("You have arrived.")).toBe("arrive");
  });

  it("ETA uses live speed when rolling, plan pace when not", () => {
    const plan = makePlan();
    const session = newDriveSession(plan, T0);
    session.progressFraction = 0;
    // Fuel at 0.30 of 100 miles = 30 miles at 50 mph = 36 minutes.
    expect(etaMinutesToStop(plan, session, plan.stops[1]!, fix(0, T0, 50))).toBe(36);
    // Stopped: plan pace - 100 miles / 120 provider minutes -
    // prices the same 30 miles at 36 minutes here.
    expect(etaMinutesToStop(plan, session, plan.stops[1]!, fix(0, T0, 0))).toBe(36);
  });
});

describe("speech builders (G-6 closed set)", () => {
  it("GO summary leads with legality, drive time left, and the first stop", () => {
    const speech = goSummarySpeech(makePlan());
    expect(speech).toContain("Legal all the way.");
    expect(speech).toContain("drive time left");
    expect(speech).toContain("First stop: Pilot — Wildwood");
  });

  it("workout approach carries the duration and the place kind", () => {
    const plan = makePlan({
      plan: {
        arrivalAt: null,
        totalElapsedMinutes: 0,
        breaks: [],
        rests: [],
        workout: {
          placed: true,
          startAt: null,
          durationMinutes: 60,
          placeName: "Anytime Fitness",
          placeKind: "gym",
          point: pointAt(0.5),
          note: "",
        },
      },
    });
    const workout = plan.stops.find((s) => s.kind === "workout")!;
    expect(approachSpeech(workout)).toBe(
      "Your workout stop is in 2 miles — 60 minutes, gym next door.",
    );
  });
});

describe("persistence (G-5)", () => {
  it("active plan round-trips; garbage parses to null", () => {
    const json = serializeActivePlan(makeResult(), T0);
    const parsed = parseActivePlan(json);
    expect(parsed?.result.load.id).toBe("load-1");
    expect(parseActivePlan("not json")).toBeNull();
    expect(parseActivePlan(null)).toBeNull();
  });

  it("checkpoint round-trips inside 12h and is refused after it", () => {
    const plan = makePlan();
    const session = newDriveSession(plan, T0);
    const json = serializeCheckpoint(plan, session, T0);
    expect(parseCheckpoint(json, T0 + 60_000)?.plan.key).toBe(plan.key);
    expect(parseCheckpoint(json, T0 + 13 * 3_600_000)).toBeNull();
    expect(parseCheckpoint("{broken", T0)).toBeNull();
  });
});

describe("driveReviewLines (G-8)", () => {
  it("reports stop outcomes honestly, including a skipped workout", () => {
    const plan = makePlan({
      plan: {
        arrivalAt: null,
        totalElapsedMinutes: 0,
        breaks: [],
        rests: [
          {
            startAt: "2026-11-02T23:00:00.000Z",
            endAt: "2026-11-03T09:00:00.000Z",
            distanceMilesFromOrigin: 62,
            fractionOfRoute: 0.62,
            startHourEastern: 23,
            point: pointAt(0.62),
          },
        ],
        workout: {
          placed: true,
          startAt: null,
          durationMinutes: 45,
          placeName: "Gym",
          placeKind: "gym",
          point: pointAt(0.5),
          note: "",
        },
      },
    });
    const session = newDriveSession(plan, T0);
    plan.stops.forEach((stop, i) => {
      session.stopStatus[i] = stop.kind === "workout" ? "skipped" : "arrived";
    });
    const lines = driveReviewLines(plan, session);
    expect(lines.some((l) => l.startsWith("Sleep: you made"))).toBe(true);
    expect(lines.some((l) => l.includes("Workout") && l.includes("skipped"))).toBe(true);
  });
});
