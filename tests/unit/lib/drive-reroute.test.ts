import { describe, expect, it } from "vitest";
import {
  INITIAL_OFF_ROUTE,
  MAX_FIX_ACCURACY_M,
  MIN_REROUTE_INTERVAL_MS,
  OFF_ROUTE_HOLD_MS,
  OFF_ROUTE_MILES,
  buildRerouteRequest,
  distanceToRouteMiles,
  evaluateRerouteResult,
  mayRequestReroute,
  reroutedSpeech,
  stepOffRoute,
} from "@/lib/drive-reroute";
import { CHECKED_AT, makePlan, makeResult, pointAt } from "../fixtures/route-check-fixture";

// The fixture route runs due north along lng -81.7 from lat 28 to 33.
const LINE = Array.from({ length: 11 }, (_, i) => ({ lat: 28 + i * 0.5, lng: -81.7 }));
const MILES_PER_DEG_LNG_AT_30 = 69.17 * Math.cos((30 * Math.PI) / 180);

describe("distanceToRouteMiles", () => {
  it("is ~0 for a point on the line, mid-segment and at a vertex", () => {
    expect(distanceToRouteMiles({ lat: 28.25, lng: -81.7 }, LINE)!).toBeLessThan(0.01);
    expect(distanceToRouteMiles({ lat: 29, lng: -81.7 }, LINE)!).toBeLessThan(0.01);
  });

  it("measures the perpendicular distance to the nearest SEGMENT, not the nearest vertex", () => {
    // 0.5 mi east of the middle of a long segment (vertices are 34 mi apart)
    const eastDeg = 0.5 / MILES_PER_DEG_LNG_AT_30;
    const d = distanceToRouteMiles({ lat: 28.25, lng: -81.7 + eastDeg }, LINE)!;
    expect(d).toBeGreaterThan(0.48);
    expect(d).toBeLessThan(0.52);
  });

  it("past either end it measures to the end point (the segment is clamped)", () => {
    const d = distanceToRouteMiles({ lat: 27.9, lng: -81.7 }, LINE)!; // 0.1 deg south of the start
    expect(d).toBeGreaterThan(6.8);
    expect(d).toBeLessThan(7.1);
  });

  it("handles a single-point and an empty geometry honestly", () => {
    expect(distanceToRouteMiles({ lat: 28, lng: -81.7 }, [{ lat: 28, lng: -81.7 }])).toBeCloseTo(0, 5);
    expect(distanceToRouteMiles({ lat: 28, lng: -81.7 }, [])).toBeNull();
  });
});

describe("stepOffRoute - a detour, not a wide turn or a bad fix", () => {
  const good = { accuracyM: 20 };
  const far = OFF_ROUTE_MILES + 0.2;

  it("being off the line starts a clock; only after the hold time does it count", () => {
    let r = stepOffRoute(INITIAL_OFF_ROUTE, { distanceMiles: far, ...good, nowMs: 1000 });
    expect(r.offRoute).toBe(false);
    r = stepOffRoute(r.state, { distanceMiles: far, ...good, nowMs: 1000 + OFF_ROUTE_HOLD_MS - 1 });
    expect(r.offRoute).toBe(false);
    r = stepOffRoute(r.state, { distanceMiles: far, ...good, nowMs: 1000 + OFF_ROUTE_HOLD_MS });
    expect(r.offRoute).toBe(true);
    expect(r.justDetected).toBe(true);
  });

  it("announces once per episode, not on every fix", () => {
    let r = stepOffRoute(INITIAL_OFF_ROUTE, { distanceMiles: far, ...good, nowMs: 0 });
    r = stepOffRoute(r.state, { distanceMiles: far, ...good, nowMs: OFF_ROUTE_HOLD_MS });
    expect(r.justDetected).toBe(true);
    const later = stepOffRoute(r.state, { distanceMiles: far, ...good, nowMs: OFF_ROUTE_HOLD_MS + 5000 });
    expect(later.offRoute).toBe(true);
    expect(later.justDetected).toBe(false);
  });

  it("getting back on the line resets everything, and a new detour is a new episode", () => {
    let r = stepOffRoute(INITIAL_OFF_ROUTE, { distanceMiles: far, ...good, nowMs: 0 });
    r = stepOffRoute(r.state, { distanceMiles: far, ...good, nowMs: OFF_ROUTE_HOLD_MS });
    r = stepOffRoute(r.state, { distanceMiles: 0.05, ...good, nowMs: OFF_ROUTE_HOLD_MS + 1000 });
    expect(r.state).toEqual(INITIAL_OFF_ROUTE);
    expect(r.offRoute).toBe(false);
    let r2 = stepOffRoute(r.state, { distanceMiles: far, ...good, nowMs: 100_000 });
    r2 = stepOffRoute(r2.state, { distanceMiles: far, ...good, nowMs: 100_000 + OFF_ROUTE_HOLD_MS });
    expect(r2.justDetected).toBe(true);
  });

  it("a brief wide turn (back on the line within the hold) never triggers", () => {
    let r = stepOffRoute(INITIAL_OFF_ROUTE, { distanceMiles: far, ...good, nowMs: 0 });
    r = stepOffRoute(r.state, { distanceMiles: 0.1, ...good, nowMs: 10_000 });
    r = stepOffRoute(r.state, { distanceMiles: far, ...good, nowMs: 20_000 });
    r = stepOffRoute(r.state, { distanceMiles: far, ...good, nowMs: 20_000 + OFF_ROUTE_HOLD_MS - 1 });
    expect(r.offRoute).toBe(false);
  });

  it("a poor or missing fix neither starts an episode nor cancels one", () => {
    const poor = stepOffRoute(INITIAL_OFF_ROUTE, { distanceMiles: far, accuracyM: MAX_FIX_ACCURACY_M + 1, nowMs: 0 });
    expect(poor.state).toEqual(INITIAL_OFF_ROUTE);
    const none = stepOffRoute(INITIAL_OFF_ROUTE, { distanceMiles: null, accuracyM: 10, nowMs: 0 });
    expect(none.state).toEqual(INITIAL_OFF_ROUTE);
    // mid-episode, a bad fix doesn't reset the clock
    let r = stepOffRoute(INITIAL_OFF_ROUTE, { distanceMiles: far, ...good, nowMs: 0 });
    r = stepOffRoute(r.state, { distanceMiles: 0.0, accuracyM: 500, nowMs: 10_000 });
    expect(r.state.offSinceMs).toBe(0);
    expect(stepOffRoute(r.state, { distanceMiles: far, ...good, nowMs: OFF_ROUTE_HOLD_MS }).justDetected).toBe(true);
  });
});

describe("the reroute request and its pacing", () => {
  it("asks for a route from HERE, with the pickup already behind him", () => {
    const plan = makePlan();
    expect(buildRerouteRequest(plan, { lat: 30.1, lng: -81.9 }, "2026-11-05T15:00:00.000Z")).toEqual({
      load_id: plan.loadId,
      depart_at: "2026-11-05T15:00:00.000Z",
      start_point: { lat: 30.1, lng: -81.9 },
      start_at: "2026-11-05T15:00:00.000Z",
      already_picked_up: true,
    });
  });

  it("never asks again within the minimum interval", () => {
    expect(mayRequestReroute(null, 5)).toBe(true);
    expect(mayRequestReroute(1000, 1000 + MIN_REROUTE_INTERVAL_MS - 1)).toBe(false);
    expect(mayRequestReroute(1000, 1000 + MIN_REROUTE_INTERVAL_MS)).toBe(true);
  });
});

describe("evaluateRerouteResult - only a truck-checked route may replace the plan", () => {
  it("accepts a provider-confirmed truck route and builds the new plan from it", () => {
    const out = evaluateRerouteResult(makeResult(), CHECKED_AT);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.plan.truckLegal).toBe(true);
      expect(out.plan.originLabel).toBe("Your position at the reroute");
      expect(out.milesToGo).toBe(out.plan.totalMiles);
      expect(reroutedSpeech(out.milesToGo)).toBe("New truck-checked route. 100 miles to go.");
    }
  });

  it("REFUSES a car route - the old plan stays, nothing is silently downgraded", () => {
    const car = makeResult();
    car.route = { ...car.route, truckLegal: false };
    expect(evaluateRerouteResult(car, CHECKED_AT)).toEqual({ ok: false, reason: "car-route" });
  });

  it("refuses a missing or empty answer", () => {
    expect(evaluateRerouteResult(null, CHECKED_AT)).toEqual({ ok: false, reason: "no-route" });
    const empty = makeResult();
    empty.route = { ...empty.route, geometry: [pointAt(0)] };
    expect(evaluateRerouteResult(empty, CHECKED_AT)).toEqual({ ok: false, reason: "no-route" });
  });
});
