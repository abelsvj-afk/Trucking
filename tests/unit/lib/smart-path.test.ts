// Smart Path v1 (docs/design/driver-mvp.md §8.3). The verdict math is
// safety-adjacent like the HOS helper it builds on: a wrong "legal"
// or a wrong arrival is a real-world problem, so the cases pin the
// exact clock interactions - break insertion, rest insertion, the
// 70-hour wall, and the appointment tradeoffs in both directions.

import { summarizeHosCycle, PROVISIONAL_HOS_CONFIG } from "@/lib/hos-cycle";
import { describe, expect, it } from "vitest";
import { summarizeHos, type DutySegmentInput } from "@/lib/hos";
import {
  checkRoute,
  clocksFromHos,
  easternHour,
  haversineMiles,
  isInFastWindow,
  pointAlongRoute,
  type ClockState,
  type RouteCheckInput,
} from "@/lib/smart-path";
import { plannedDriveMinutes, routeCaption } from "@/lib/smart-path";

const FRESH: ClockState = {
  driveLeftMin: 660,
  windowLeftMin: 840,
  breakLeftMin: 480,
  weekLeftMin: 4200,
  fromLogs: true,
};

function input(overrides: Partial<RouteCheckInput>): RouteCheckInput {
  return {
    now: new Date("2026-11-02T09:00:00Z"),
    departAt: new Date("2026-11-02T10:00:00Z"), // 5:00 AM EST
    distanceMiles: 300,
    providerDurationMinutes: 330,
    clocks: FRESH,
    governedSpeedMph: null,
    pickupWindow: null,
    deliveryWindow: null,
    rateCents: null,
    loadMiles: null,
    ...overrides,
  };
}

describe("clocksFromHos", () => {
  it("assumes fresh clocks (flagged as not from logs) with no duty logs", () => {
    // An empty window: the carrier cycle has used nothing, so its full limit is left.
    const clocks = clocksFromHos(summarizeHos([], new Date("2026-11-01T20:00:00Z")), 4200);
    expect(clocks.fromLogs).toBe(false);
    expect(clocks.driveLeftMin).toBe(660);
    expect(clocks.windowLeftMin).toBe(840);
    expect(clocks.weekLeftMin).toBe(4200);
  });

  it("derives remaining clocks from a real summary", () => {
    // On duty 12:00Z, driving from 13:00Z, still driving at 20:00Z:
    // 420 driving minutes in the window, 480 elapsed, 420 since the
    // (on-duty) break before the driving started, 480 on-duty in 8 days.
    const logs: DutySegmentInput[] = [
      { duty_status: "on_duty", started_at: "2026-11-01T12:00:00Z" },
      { duty_status: "driving", started_at: "2026-11-01T13:00:00Z" },
    ];
    const now = new Date("2026-11-01T20:00:00Z");
    // The week clock comes from the carrier-anchored cycle (King D-1),
    // never hos.ts's rolling 8-day sum.
    const cycle = summarizeHosCycle(logs, now, PROVISIONAL_HOS_CONFIG);
    const clocks = clocksFromHos(summarizeHos(logs, now), cycle.cycleLimitMinutes - cycle.onDutyMinutesInCycle);
    expect(clocks.fromLogs).toBe(true);
    expect(clocks.driveLeftMin).toBe(660 - 420);
    expect(clocks.windowLeftMin).toBe(840 - 480);
    expect(clocks.breakLeftMin).toBe(480 - 420);
    expect(clocks.weekLeftMin).toBe(4200 - 480);
  });
});

describe("checkRoute - HOS vs appointment verdicts", () => {
  it("on time: short run, fresh clocks, no break or rest needed", () => {
    const result = checkRoute(
      input({
        deliveryWindow: { start: "2026-11-02T15:00:00Z", end: "2026-11-02T22:00:00Z" },
      }),
    );
    expect(result.status).toBe("on_time");
    expect(result.plan?.arrivalAt).toBe("2026-11-02T15:30:00.000Z");
    expect(result.plan?.breaks).toEqual([]);
    expect(result.plan?.rests).toEqual([]);
    expect(result.makeItDepartureAt).toBe("2026-11-02T16:30:00.000Z");
    expect(result.tradeoffLines[0]).toContain("to spare");
    expect(result.restedLines[0]).toContain("No sleep stop needed");
  });

  it("inserts the 30-minute break when driving passes 8 hours", () => {
    const result = checkRoute(input({ distanceMiles: 600, providerDurationMinutes: 660 }));
    expect(result.status).toBe("on_time");
    expect(result.plan?.breaks).toHaveLength(1);
    expect(result.plan?.breaks[0]?.startAt).toBe("2026-11-02T18:00:00.000Z");
    expect(result.plan?.breaks[0]?.afterDrivingMinutes).toBe(480);
    expect(result.plan?.rests).toEqual([]);
    expect(result.plan?.arrivalAt).toBe("2026-11-02T21:30:00.000Z");
    expect(result.legalLines[0]).toContain("30-minute break");
  });

  it("inserts a 10-hour sleep stop when the 11-hour drive clock runs out, and places it on the route", () => {
    const result = checkRoute(
      input({
        departAt: new Date("2026-11-02T11:00:00Z"), // 6:00 AM EST
        distanceMiles: 900,
        providerDurationMinutes: 1020,
      }),
    );
    expect(result.plan?.rests).toHaveLength(1);
    expect(result.plan?.breaks).toHaveLength(1);
    const rest = result.plan!.rests[0]!;
    expect(rest.startAt).toBe("2026-11-02T22:30:00.000Z");
    expect(rest.distanceMilesFromOrigin).toBe(582);
    expect(rest.fractionOfRoute).toBeCloseTo(660 / 1020, 5);
    // 480 drive + 30 break + 180 drive + 600 rest + 360 drive = 1650 elapsed.
    expect(result.plan?.arrivalAt).toBe("2026-11-03T14:30:00.000Z");
  });

  it("calls a rest that lands at night a good sleep, in words", () => {
    const result = checkRoute(
      input({
        departAt: new Date("2026-11-02T17:00:00Z"), // noon EST - rest lands 11:30 PM EST
        distanceMiles: 900,
        providerDurationMinutes: 1020,
      }),
    );
    expect(result.plan?.rests[0]?.startHourEastern).toBe(23);
    expect(result.restedLines[0]).toContain("normal night hours");
  });

  it("flags a mid-day sleep as the rested-governor problem it is", () => {
    // 1h of drive left on the clock, leaving 10 AM EST: the forced
    // 10-hour rest starts 11 AM EST - legal, but a mid-day sleep.
    const result = checkRoute(
      input({
        departAt: new Date("2026-11-02T15:00:00Z"), // 10:00 AM EST
        distanceMiles: 700,
        providerDurationMinutes: 780,
        clocks: { ...FRESH, driveLeftMin: 60 },
      }),
    );
    expect(result.plan?.rests.length).toBeGreaterThan(0);
    const midday = result.restedLines.some((line) => line.includes("mid-day"));
    expect(midday).toBe(true);
  });

  it("an exhausted 14-hour window forces a rest before departure, at mile 0", () => {
    const result = checkRoute(
      input({
        distanceMiles: 200,
        providerDurationMinutes: 240,
        clocks: { ...FRESH, driveLeftMin: 400, windowLeftMin: 0, breakLeftMin: 200 },
      }),
    );
    expect(result.status).not.toBe("not_legal");
    expect(result.plan?.rests).toHaveLength(1);
    expect(result.plan?.rests[0]?.fractionOfRoute).toBe(0);
    expect(result.plan?.rests[0]?.distanceMilesFromOrigin).toBe(0);
  });

  it("late: states how late and the departure that would have made it", () => {
    const result = checkRoute(
      input({
        departAt: new Date("2026-11-02T15:00:00Z"), // 10:00 AM EST
        deliveryWindow: { start: "2026-11-02T17:00:00Z", end: "2026-11-02T19:00:00Z" },
      }),
    );
    expect(result.status).toBe("late");
    expect(result.plan?.arrivalAt).toBe("2026-11-02T20:30:00.000Z");
    expect(result.makeItDepartureAt).toBe("2026-11-02T13:30:00.000Z");
    expect(result.tradeoffLines[0]).toContain("1h 30m after the window closes");
    expect(result.tradeoffLines[0]).toContain("Leaving by");
  });

  it("early: warns that arriving before the window opens is self-scheduled detention", () => {
    const result = checkRoute(
      input({
        deliveryWindow: { start: "2026-11-02T18:00:00Z", end: "2026-11-02T23:00:00Z" },
      }),
    );
    expect(result.status).toBe("early");
    expect(result.tradeoffLines[0]).toContain("before the window opens");
  });

  it("not legal: the 70-hour clock is a wall a rest cannot fix", () => {
    const result = checkRoute(
      input({
        distanceMiles: 600,
        providerDurationMinutes: 660,
        clocks: { ...FRESH, weekLeftMin: 300 },
      }),
    );
    expect(result.status).toBe("not_legal");
    expect(result.legalLines[0]).toContain("70-hour");
    expect(result.plan?.arrivalAt).toBeNull();
  });

  it("warns (not blocks) when the planned departure is outside the pickup window", () => {
    const result = checkRoute(
      input({
        pickupWindow: { start: "2026-11-02T12:00:00Z", end: "2026-11-02T17:00:00Z" },
      }),
    );
    expect(result.warnings.some((w) => w.includes("before the pickup window opens"))).toBe(true);
  });

  it("flags the fresh-clocks assumption out loud when there are no logs", () => {
    const result = checkRoute(input({ clocks: { ...FRESH, fromLogs: false } }));
    expect(result.warnings.some((w) => w.includes("fresh clocks"))).toBe(true);
  });

  it("paid governor: per-mile math only from the load's own numbers", () => {
    const result = checkRoute(input({ rateCents: 150_000, loadMiles: 500 }));
    expect(result.paidLines[0]).toContain("$1,500.00");
    expect(result.paidLines[0]).toContain("$3.00 a mile");
    const noMiles = checkRoute(input({ rateCents: 150_000, loadMiles: null }));
    expect(noMiles.paidLines[0]).toContain("no per-mile figure");
  });

  it("drive time takes the slower of provider estimate and governed-speed math", () => {
    // 300 miles at 50 mph governed = 360 min > provider's 330.
    const result = checkRoute(input({ governedSpeedMph: 50 }));
    expect(result.assumedDriveMinutes).toBe(360);
    expect(result.driveTimeBasis).toContain("50 mph");
    expect(result.plan?.arrivalAt).toBe("2026-11-02T16:00:00.000Z");
  });
});

describe("fast window (8pm-8am Eastern)", () => {
  it("knows Eastern hours across DST and standard time", () => {
    expect(easternHour(new Date("2026-01-15T13:00:00Z"))).toBe(8); // 8 AM EST
    expect(easternHour(new Date("2026-07-15T12:00:00Z"))).toBe(8); // 8 AM EDT
    expect(easternHour(new Date("2026-07-15T00:00:00Z"))).toBe(20); // 8 PM EDT
  });

  it("suppresses the whole 8pm-8am span and nothing outside it", () => {
    expect(isInFastWindow(new Date("2026-01-15T01:00:00Z"))).toBe(true); // 8:00 PM EST
    expect(isInFastWindow(new Date("2026-01-15T12:30:00Z"))).toBe(true); // 7:30 AM EST
    expect(isInFastWindow(new Date("2026-01-15T13:00:00Z"))).toBe(false); // 8:00 AM EST
    expect(isInFastWindow(new Date("2026-01-15T17:00:00Z"))).toBe(false); // noon EST
    expect(isInFastWindow(new Date("2026-01-16T00:59:00Z"))).toBe(false); // 7:59 PM EST
  });
});

describe("geometry helpers", () => {
  it("haversine: Melbourne FL to Atlanta GA is about 450 miles straight-line", () => {
    const miles = haversineMiles({ lat: 28.0836, lng: -80.6081 }, { lat: 33.749, lng: -84.388 });
    expect(miles).toBeGreaterThan(430);
    expect(miles).toBeLessThan(480);
  });

  it("pointAlongRoute interpolates the midpoint", () => {
    const mid = pointAlongRoute(
      [
        { lat: 28, lng: -80 },
        { lat: 34, lng: -84 },
      ],
      0.5,
    );
    expect(mid?.lat).toBeCloseTo(31, 0);
    expect(mid?.lng).toBeCloseTo(-82, 0);
  });
});

// ---------------------------------------------------------------------
// Piece 1 additions (P1-1 caption, P1-7 deadhead, P1-9 lifestyle).
// Everything above is pre-existing and unmodified; the cases below
// only add. The hard constraint they pin: with no preLeg, no life and
// no workout, the new fields default (lifeLines [], leaveStartByAt
// null, preLeg null, plan.workout null, breaks 30 minutes / "break").
// ---------------------------------------------------------------------

describe("routeCaption (P1-1)", () => {
  it("truck-checked branch: provider verbatim, OSM limits named, ELD is the final word", () => {
    const caption = routeCaption({ provider: "Valhalla (truck costing)", truckLegal: true });
    expect(caption).toBe(
      "Route by Valhalla (truck costing) — truck-checked against the height/weight limits and truck-prohibited roads recorded in OpenStreetMap data. That data is incomplete: a road with no recorded limit reads as passable. The truck's own nav/ELD is the final word.",
    );
    expect(caption).toContain("final word");
  });

  it("car-route branch: provider verbatim and NOT checked, in capitals", () => {
    const caption = routeCaption({ provider: "OSRM", truckLegal: false });
    expect(caption).toBe(
      "Route by OSRM — a standard CAR route, NOT checked against truck restrictions. Don't roll on this line alone; check it against the truck's own nav/ELD.",
    );
    expect(caption).toContain("NOT checked");
  });
});

describe("plannedDriveMinutes (P1-7 plan-speed rule)", () => {
  it("takes the slower of provider duration and speed math, both legs", () => {
    expect(plannedDriveMinutes(110, 100, null)).toBe(120); // 110 mi at 55 mph
    expect(plannedDriveMinutes(55, 90, null)).toBe(90); // provider is slower
    expect(plannedDriveMinutes(100, 90, 50)).toBe(120); // governed 50 mph
  });
});

describe("new-field defaults with no preLeg / life / workout", () => {
  it("default result fields are empty/null and breaks carry 30 minutes / kind break", () => {
    const result = checkRoute(input({ distanceMiles: 600, providerDurationMinutes: 660 }));
    expect(result.lifeLines).toEqual([]);
    expect(result.leaveStartByAt).toBeNull();
    expect(result.preLeg).toBeNull();
    expect(result.plan?.workout).toBeNull();
    expect(result.plan?.breaks[0]).toEqual({
      startAt: "2026-11-02T18:00:00.000Z",
      afterDrivingMinutes: 480,
      durationMinutes: 30,
      kind: "break",
    });
  });
});

describe("checkRoute - deadhead preLeg (P1-7)", () => {
  const PRE_LEG = { distanceMiles: 55, providerDurationMinutes: 60 };

  it("wait case: pickup arrival 50 minutes before departAt waits at the pickup; delivery arrival is unchanged", () => {
    const solo = checkRoute(input({}));
    const result = checkRoute(
      input({ preLeg: { ...PRE_LEG, startAt: new Date("2026-11-02T08:10:00Z") } }),
    );
    expect(result.preLeg).toEqual({
      plannedMinutes: 60,
      startAt: "2026-11-02T08:10:00.000Z",
      pickupArrivalAt: "2026-11-02T09:10:00.000Z",
      waitMinutesAtPickup: 50,
    });
    expect(result.plan?.arrivalAt).toBe(solo.plan?.arrivalAt);
    expect(result.status).toBe(solo.status);
    expect(result.warnings.some((w) => w.includes("Clocks are projected"))).toBe(false);
  });

  it("slip case: pickup arrival after departAt shifts the delivery arrival and the tradeoffs say so", () => {
    const result = checkRoute(
      input({ preLeg: { ...PRE_LEG, startAt: new Date("2026-11-02T09:40:00Z") } }),
    );
    expect(result.preLeg?.pickupArrivalAt).toBe("2026-11-02T10:40:00.000Z");
    expect(result.preLeg?.waitMinutesAtPickup).toBe(0);
    expect(result.plan?.arrivalAt).toBe("2026-11-02T16:10:00.000Z");
    expect(
      result.tradeoffLines.some(
        (line) => line.includes("You'd reach the pickup 40m after your planned") && line.includes("everything below starts from"),
      ),
    ).toBe(true);
    // The start is in the future relative to `now`, so the projection caveat fires.
    expect(result.warnings).toContain("Clocks are projected from your logs as of now.");
  });

  it("break-in-deadhead: a low break clock forces the 30-minute break inside the pre-leg", () => {
    const result = checkRoute(
      input({
        clocks: { ...FRESH, breakLeftMin: 30 },
        preLeg: { ...PRE_LEG, startAt: null },
      }),
    );
    expect(result.preLeg?.startAt).toBe("2026-11-02T09:00:00.000Z"); // just-in-time
    expect(result.plan?.breaks).toHaveLength(1);
    expect(result.plan?.breaks[0]?.afterDrivingMinutes).toBe(30);
    expect(result.plan?.breaks[0]?.afterDrivingMinutes).toBeLessThan(result.preLeg!.plannedMinutes);
    expect(result.plan?.breaks[0]?.startAt).toBe("2026-11-02T09:30:00.000Z");
    expect(result.preLeg?.pickupArrivalAt).toBe("2026-11-02T10:30:00.000Z");
    expect(result.plan?.arrivalAt).toBe("2026-11-02T16:00:00.000Z");
  });

  it("deadhead-only illegality: legal from the pickup, not legal from the start - and the tradeoff calls it out", () => {
    const clocks = { ...FRESH, weekLeftMin: 360 };
    const solo = checkRoute(input({ clocks }));
    expect(solo.status).toBe("on_time");
    const result = checkRoute(
      input({ clocks, preLeg: { ...PRE_LEG, startAt: null, startLabel: "Melbourne, FL" } }),
    );
    expect(result.status).toBe("not_legal");
    expect(result.tradeoffLines).toContain(
      "From the pickup this run was legal. From Melbourne, FL, the deadhead burns 1h of your 14 first.",
    );
  });

  it("leaveStartByAt anchors to the delivery close with a preLeg, and is null without a window or a preLeg", () => {
    const window = { start: "2026-11-02T15:00:00Z", end: "2026-11-02T22:00:00Z" };
    const withWindow = checkRoute(
      input({
        deliveryWindow: window,
        preLeg: { ...PRE_LEG, startAt: new Date("2026-11-02T08:10:00Z") },
      }),
    );
    // Total elapsed 440 minutes (390 driving + 50 waiting at the pickup).
    expect(withWindow.leaveStartByAt).toBe("2026-11-02T14:40:00.000Z");
    // makeItDepartureAt keeps its leave-the-pickup meaning: the wait
    // case reproduces the no-preLeg figure from the existing tests.
    expect(withWindow.makeItDepartureAt).toBe("2026-11-02T16:30:00.000Z");

    const noWindow = checkRoute(
      input({ preLeg: { ...PRE_LEG, startAt: new Date("2026-11-02T08:10:00Z") } }),
    );
    expect(noWindow.leaveStartByAt).toBeNull();

    const noPreLeg = checkRoute(input({ deliveryWindow: window }));
    expect(noPreLeg.leaveStartByAt).toBeNull();
    expect(noPreLeg.makeItDepartureAt).toBe("2026-11-02T16:30:00.000Z");
  });
});

describe("checkRoute - lifestyle (P1-9)", () => {
  const GYM = {
    name: "Anytime Fitness, I-75",
    kind: "gym" as const,
    drivenMinutes: 500,
    point: { lat: 32, lng: -83 },
  };

  it("example 1: the workout fits by extending the break at a nearby gym", () => {
    const result = checkRoute(
      input({
        distanceMiles: 600,
        providerDurationMinutes: 660,
        deliveryWindow: { start: "2026-11-02T19:00:00Z", end: "2026-11-02T23:00:00Z" },
        life: { workout: { want: true, minutes: 60, setting: "gym_preferred" } },
        workoutAnchors: [GYM],
      }),
    );
    expect(result.plan?.workout?.placed).toBe(true);
    expect(result.plan?.workout?.placeKind).toBe("gym");
    expect(result.plan?.workout?.placeName).toBe("Anytime Fitness, I-75");
    expect(result.plan?.workout?.startAt).toBe("2026-11-02T18:00:00.000Z");
    expect(result.plan?.workout?.point).toEqual({ lat: 32, lng: -83 });
    expect(result.plan?.breaks[0]?.durationMinutes).toBe(60);
    expect(result.plan?.breaks[0]?.kind).toBe("workout");
    expect(result.plan?.arrivalAt).toBe("2026-11-02T22:00:00.000Z");
    expect(result.status).toBe("on_time");
    expect(result.lifeLines).toContain(
      "Workout: 60 minutes at Anytime Fitness, I-75 — it doubles as your 30-minute break.",
    );
  });

  it("example 2: a tight window leaves no room - placed false, the note names the overrun and the earlier departure", () => {
    const result = checkRoute(
      input({
        distanceMiles: 600,
        providerDurationMinutes: 660,
        deliveryWindow: { start: "2026-11-02T20:00:00Z", end: "2026-11-02T21:50:00Z" },
        life: { workout: { want: true, minutes: 60, setting: "gym_preferred" } },
        workoutAnchors: [GYM],
      }),
    );
    expect(result.plan?.workout?.placed).toBe(false);
    expect(result.plan?.workout?.note).toContain("10m after the window closes");
    expect(result.plan?.workout?.note).toContain("leave 10m+ minutes earlier");
    // The run itself is untouched by the failed placement.
    expect(result.plan?.arrivalAt).toBe("2026-11-02T21:30:00.000Z");
    expect(result.status).toBe("on_time");
    expect(result.plan?.breaks[0]?.durationMinutes).toBe(30);
    expect(result.plan?.breaks[0]?.kind).toBe("break");
  });

  it("example 4: a workout at 9 PM inside the fast is still placed - the fast never suppresses training", () => {
    const result = checkRoute(
      input({
        departAt: new Date("2026-11-02T18:00:00Z"), // 1:00 PM EST; break lands 9:00 PM EST
        distanceMiles: 600,
        providerDurationMinutes: 660,
        life: { workout: { want: true, minutes: 60, setting: "gym_preferred" } },
        workoutAnchors: [{ ...GYM, drivenMinutes: 480 }],
      }),
    );
    expect(result.plan?.workout?.placed).toBe(true);
    expect(result.plan?.workout?.startAt).toBe("2026-11-03T02:00:00.000Z");
    expect(easternHour(new Date(result.plan!.workout!.startAt!))).toBe(21);
    expect(isInFastWindow(new Date(result.plan!.workout!.startAt!))).toBe(true);
  });

  it("example 5: the same rest flips its verdict between sleep 22→6 and sleep 0→8, and the fix is priced", () => {
    const fixture = {
      departAt: new Date("2026-11-02T17:00:00Z"), // rest starts 11:30 PM EST
      distanceMiles: 900,
      providerDurationMinutes: 1020,
    };
    const nightOwl = checkRoute(input({ ...fixture, life: { sleepStartHour: 22, sleepEndHour: 6 } }));
    expect(nightOwl.plan?.rests[0]?.startHourEastern).toBe(23);
    expect(nightOwl.restedLines[0]).toContain("inside your 10 PM–6 AM window");
    expect(nightOwl.lifeLines).toEqual([]);

    const earlyBird = checkRoute(input({ ...fixture, life: { sleepStartHour: 0, sleepEndHour: 8 } }));
    expect(earlyBird.restedLines[0]).toContain("outside your 12 AM–8 AM window");
    expect(
      earlyBird.lifeLines.some(
        (line) =>
          line.includes("outside your 12 AM–8 AM window") &&
          line.includes("Leaving 30m later") &&
          line.includes("inside — if the pickup window allows."),
      ),
    ).toBe(true);
  });

  it("a sleep already past the window's end says a later departure cannot fix it", () => {
    const result = checkRoute(
      input({
        departAt: new Date("2026-11-02T15:00:00Z"), // first rest starts 11:00 AM EST
        distanceMiles: 700,
        providerDurationMinutes: 780,
        clocks: { ...FRESH, driveLeftMin: 60 },
        life: { sleepStartHour: 22, sleepEndHour: 6 },
      }),
    );
    expect(result.plan?.rests.length).toBeGreaterThan(0);
    expect(result.restedLines.every((line) => line.includes("outside your 10 PM–6 AM window"))).toBe(true);
    expect(result.lifeLines.some((line) => line.includes("past the window's end"))).toBe(true);
  });

  it("a requested workout on an illegal run reports placed false with the illegality named", () => {
    const result = checkRoute(
      input({
        distanceMiles: 600,
        providerDurationMinutes: 660,
        clocks: { ...FRESH, weekLeftMin: 300 },
        life: { workout: { want: true, minutes: 60, setting: "any_safe_stop" } },
        workoutAnchors: [GYM],
      }),
    );
    expect(result.status).toBe("not_legal");
    expect(result.plan?.workout?.placed).toBe(false);
    expect(result.plan?.workout?.note).toBe("No workout to place — this run isn't legal as planned.");
  });
});
