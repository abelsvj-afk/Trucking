import { describe, expect, it } from "vitest";
import { buildCorridor, etaAtMile } from "@/lib/smart-path-corridor";
import type { RoutePlan } from "@/lib/smart-path";

// ~69 miles per degree of latitude: a straight north-south line.
const line = [{ lat: 30, lng: -90 }, { lat: 31, lng: -90 }, { lat: 32, lng: -90 }];

describe("buildCorridor", () => {
  it("places evenly spaced points including both ends", () => {
    const r = buildCorridor(line, 25);
    if (!r.ok) throw new Error(r.reason);
    const { points, totalMiles } = r.corridor;
    expect(totalMiles).toBeGreaterThan(135);
    expect(totalMiles).toBeLessThan(142);
    expect(points[0]!.mileFromStart).toBe(0);
    expect(points[points.length - 1]!.fraction).toBe(1);
    expect(points[1]!.mileFromStart).toBe(25);
    expect(points[1]!.lat).toBeGreaterThan(30);
    expect(points[1]!.lat).toBeLessThan(30.5);
  });
  it("says so when there is no corridor", () => {
    expect(buildCorridor([{ lat: 1, lng: 1 }]).ok).toBe(false);
    expect(buildCorridor([{ lat: 1, lng: 1 }, { lat: 1, lng: 1 }]).ok).toBe(false);
    expect(buildCorridor(line, 0).ok).toBe(false);
  });
});

describe("etaAtMile", () => {
  const plan: RoutePlan = {
    feasible: true, infeasibleReason: null, arrivalAt: null, totalElapsedMinutes: 700, drivingMinutes: 600,
    breaks: [], rests: [],
    // 300 driven min, then a 100-min stop, then the rest.
    checkpoints: [{ drivenMinutes: 0, elapsedMinutes: 0 }, { drivenMinutes: 300, elapsedMinutes: 300 }, { drivenMinutes: 300, elapsedMinutes: 400 }, { drivenMinutes: 600, elapsedMinutes: 700 }],
    workout: null,
  };
  const depart = new Date("2026-11-06T10:00:00Z");
  it("includes rests in the time he reaches a mile", () => {
    expect(etaAtMile(plan, depart, 0, 600)!.toISOString()).toBe(depart.toISOString());
    expect(etaAtMile(plan, depart, 600, 600)!.getTime() - depart.getTime()).toBe(700 * 60_000);
    // 3/4 of the way = 450 driven min -> 550 elapsed
    expect(etaAtMile(plan, depart, 450, 600)!.getTime() - depart.getTime()).toBe(550 * 60_000);
  });
  it("is null for an infeasible plan", () => {
    expect(etaAtMile({ ...plan, feasible: false }, depart, 10, 600)).toBeNull();
  });
});
