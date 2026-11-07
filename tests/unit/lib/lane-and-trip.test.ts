// Lane rate history and "can I make it?" (owner 2026-11-07).

import { describe, expect, it } from "vitest";
import { formatLaneStats, laneAverager, laneStats, stateOf, type LaneLoad } from "@/lib/lane-stats";
import { BREAK_MS, DRIVE_LIMIT_MS, HOUR_MS, RESET_MS, describeTripPlan, easternToEpoch, parseClock, planTrip } from "@/lib/trip-plan";

const load = (origin: string, destination: string, rate: number, miles: number, day: string): LaneLoad => ({ origin, destination, rate_cents: rate, miles, delivery_date: day });

describe("stateOf", () => {
  it("reads a state from 'City, ST', a code or a name", () => {
    expect(stateOf("Tampa, FL")).toBe("FL");
    expect(stateOf("Macon, ga")).toBe("GA");
    expect(stateOf("Florida")).toBe("FL");
    expect(stateOf("Nowhere")).toBeNull();
  });
});

describe("laneStats", () => {
  const history = [
    load("Macon, GA", "Tampa, FL", 120000, 500, "2026-09-01"), // 240
    load("Macon, GA", "Tampa, FL", 100000, 500, "2026-09-20"), // 200
    load("Atlanta, GA", "Miami, FL", 130000, 650, "2026-10-05"), // 200
    load("Macon, GA", "Orlando, FL", 135000, 450, "2026-10-20"), // 300
    load("Macon, GA", "Dallas, TX", 200000, 800, "2026-10-25"), // 250 - other lane
    { origin: "Macon, GA", destination: "Tampa, FL", rate_cents: null, miles: 500, delivery_date: "2026-10-30" }, // unpriced
  ];
  it("averages his own rate per mile over the matching lane, ignoring unpriced loads and other lanes", () => {
    const s = laneStats(history, "GA", "FL");
    expect(s.n).toBe(4);
    expect(s.avgCents).toBe(235);
    expect(s.minCents).toBe(200);
    expect(s.maxCents).toBe(300);
    expect(s.medianCents).toBe(220);
    expect(s.recent.map((r) => r.day)).toEqual(["2026-10-20", "2026-10-05", "2026-09-20"]);
  });
  it("matches on city text when the state columns are empty, and 'anywhere' on either side", () => {
    expect(laneStats(history, "Georgia", "Florida").n).toBe(4);
    expect(laneStats(history, null, "TX").n).toBe(1);
    expect(laneStats(history, "GA", null).n).toBe(5);
  });
  it("trend: recent loads against the overall average, only with 4+ loads", () => {
    const s = laneStats(history, "GA", "FL");
    expect(s.trendCents).toBe(Math.round((300 + 200 + 200) / 3 - 235));
    expect(laneStats(history.slice(0, 2), "GA", "FL").trendCents).toBeNull();
  });
  it("an empty lane is said to be empty; a thin one is said to be thin - never a 'market rate'", () => {
    expect(formatLaneStats("GA", "WA", laneStats(history, "GA", "WA"))).toMatch(/No priced loads of his on GA → WA yet/);
    const thin = formatLaneStats("GA", "TX", laneStats(history, "GA", "TX"));
    expect(thin).toMatch(/only 1 load - too thin to call a market rate/);
    expect(formatLaneStats("GA", "FL", laneStats(history, "GA", "FL"))).toMatch(/not the market/);
  });
  it("laneAverager needs 2+ loads on the lane", () => {
    const avg = laneAverager(history);
    expect(avg({ origin_state: "GA", destination_state: "FL" })).toBe(235);
    expect(avg({ origin_state: "GA", destination_state: "TX" })).toBeNull(); // only 1
    expect(avg({ origin_state: null, destination_state: "FL" })).toBeNull();
  });
});

describe("planTrip: hours-of-service arithmetic", () => {
  const NOW = Date.parse("2026-11-07T14:00:00Z");
  const full = { driveLeftMs: 11 * HOUR_MS, windowLeftMs: 14 * HOUR_MS, breakDueInMs: 8 * HOUR_MS };

  it("a short trip is just driving time", () => {
    const p = planTrip(250, 50, NOW, full);
    expect(p.driveMs).toBe(5 * HOUR_MS);
    expect(p.arriveAt - NOW).toBe(5 * HOUR_MS);
    expect(p.stops).toEqual([]);
  });
  it("a 30-minute break is inserted after 8 hours of driving and costs window time, not drive time", () => {
    const p = planTrip(450, 50, NOW, full); // 9 hours of driving
    expect(p.stops.map((s) => s.kind)).toEqual(["break"]);
    expect(p.stops[0]!.atMile).toBe(400);
    expect(p.arriveAt - NOW).toBe(9 * HOUR_MS + BREAK_MS);
  });
  it("a trip over 11 hours of driving forces a 10-hour reset", () => {
    const p = planTrip(700, 50, NOW, full); // 14 hours of driving
    expect(p.resets).toBe(1);
    expect(p.stops.map((s) => s.kind)).toEqual(["break", "reset"]);
    expect(p.arriveAt - NOW).toBe(14 * HOUR_MS + BREAK_MS + RESET_MS);
    expect(p.stops.find((s) => s.kind === "reset")!.atMile).toBe(550); // 11 hours at 50 mph
  });
  it("the 14-hour window can end the day before the 11 hours of driving do", () => {
    const p = planTrip(300, 50, NOW, { driveLeftMs: 11 * HOUR_MS, windowLeftMs: 2 * HOUR_MS, breakDueInMs: 8 * HOUR_MS }); // 6h drive, 2h of window
    expect(p.resets).toBe(1);
    expect(p.stops[0]!.atMile).toBe(100);
    expect(p.arriveAt - NOW).toBe(6 * HOUR_MS + RESET_MS);
  });
  it("starting with a break already due takes it first", () => {
    const p = planTrip(100, 50, NOW, { ...full, breakDueInMs: 0 });
    expect(p.stops.map((s) => s.kind)).toEqual(["break"]);
    expect(p.arriveAt - NOW).toBe(2 * HOUR_MS + BREAK_MS);
  });
  it("with no clocks it assumes a fresh start; with a cycle shorter than the trip it says so", () => {
    expect(planTrip(250, 50, NOW, null).arriveAt - NOW).toBe(5 * HOUR_MS);
    expect(planTrip(500, 50, NOW, { ...full, cycleLeftMs: 4 * HOUR_MS }).cycleShort).toBe(true);
    expect(planTrip(100, 50, NOW, { ...full, cycleLeftMs: 40 * HOUR_MS }).cycleShort).toBe(false);
  });
  it("zero miles arrives now; a bad speed falls back to the default", () => {
    expect(planTrip(0, 50, NOW, full).arriveAt).toBe(NOW);
    expect(planTrip(100, 0, NOW, full).driveMs).toBe(2 * HOUR_MS);
  });
  it("never exceeds the limits no matter the length (drive between resets <= 11h)", () => {
    const p = planTrip(3000, 55, NOW, full);
    const resets = p.stops.filter((s) => s.kind === "reset");
    expect(resets.length).toBeGreaterThanOrEqual(4);
    expect(p.arriveAt - NOW).toBeGreaterThanOrEqual(p.driveMs + resets.length * RESET_MS);
    expect(DRIVE_LIMIT_MS).toBe(11 * HOUR_MS);
  });
});

describe("appointments and clock text", () => {
  it("parses clock times", () => {
    expect(parseClock("8am")).toEqual({ hour: 8, minute: 0 });
    expect(parseClock("8:30 PM")).toEqual({ hour: 20, minute: 30 });
    expect(parseClock("12am")).toEqual({ hour: 0, minute: 0 });
    expect(parseClock("12pm")).toEqual({ hour: 12, minute: 0 });
    expect(parseClock("14:00")).toEqual({ hour: 14, minute: 0 });
    expect(parseClock("0800")).toEqual({ hour: 8, minute: 0 });
    for (const bad of ["25:00", "13pm", "noon-ish", ""]) expect(parseClock(bad)).toBeNull();
  });
  it("turns an Eastern wall-clock time into the right instant on both sides of daylight saving", () => {
    expect(new Date(easternToEpoch("2026-11-07", 8, 0)!).toISOString()).toBe("2026-11-07T13:00:00.000Z"); // EST (UTC-5)
    expect(new Date(easternToEpoch("2026-07-07", 8, 0)!).toISOString()).toBe("2026-07-07T12:00:00.000Z"); // EDT (UTC-4)
  });
  it("tells him whether the appointment is reachable, with the margin or how late", () => {
    const now = Date.parse("2026-11-07T14:00:00Z");
    const plan = planTrip(250, 50, now, null); // arrives 19:00Z
    const early = describeTripPlan(plan, now, 250, 50, Date.parse("2026-11-07T22:00:00Z"), true);
    expect(early).toMatch(/you make it with 3h to spare/);
    const late = describeTripPlan(plan, now, 250, 50, Date.parse("2026-11-07T17:30:00Z"), false);
    expect(late).toMatch(/LATE/);
    expect(late).toMatch(/assumes you start with full hours/);
    expect(late).toMatch(/Planning arithmetic only/);
  });
});
