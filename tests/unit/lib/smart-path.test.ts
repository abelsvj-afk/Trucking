// Smart Path v1 (docs/design/driver-mvp.md §8.3). The verdict math is
// safety-adjacent like the HOS helper it builds on: a wrong "legal"
// or a wrong arrival is a real-world problem, so the cases pin the
// exact clock interactions - break insertion, rest insertion, the
// 70-hour wall, and the appointment tradeoffs in both directions.

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
    const clocks = clocksFromHos(summarizeHos([], new Date("2026-11-01T20:00:00Z")));
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
    const clocks = clocksFromHos(summarizeHos(logs, new Date("2026-11-01T20:00:00Z")));
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
    expect(result.paidLines[0]).toContain("$1500.00");
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
