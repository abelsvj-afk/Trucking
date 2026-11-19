// One way of measuring miles (owner 2026-11-18: "11 mi to I-20, other map 19").
import { describe, expect, it } from "vitest";
import { bearingDeg, buildRouteMeasure, headingAtRoadMiles, measurePoint, pointAtRoadMiles } from "@/lib/route-measure";

// Straight northbound line, ~1 line-mile per 0.01449° of latitude.
const line = (miles: number, lat0 = 30) => Array.from({ length: miles + 1 }, (_, i) => ({ lat: lat0 + i * 0.01449, lng: -82 }));

describe("route measure", () => {
  it("projects onto the SEGMENT, never snapping to a vertex", () => {
    const m = buildRouteMeasure([{ geometry: line(10), roadMiles: 0 }]);
    expect(measurePoint(m, { lat: 30 + 3.5 * 0.01449, lng: -82 })!.roadMiles).toBeCloseTo(3.5, 1);
  });

  it("reports ROAD miles: a simplified line that is shorter than the road is scaled up to the road", () => {
    // The line is 10 mi long but the router says the road is 19 mi.
    const m = buildRouteMeasure([{ geometry: line(10), roadMiles: 19 }]);
    expect(m.totalRoadMiles).toBe(19);
    expect(measurePoint(m, { lat: 30 + 5 * 0.01449, lng: -82 })!.roadMiles).toBeCloseTo(9.5, 1);
  });

  it("scales each leg on its own (deadhead and loaded are simplified differently)", () => {
    const dead = line(2);
    const loaded = line(10, dead[2]!.lat);
    const m = buildRouteMeasure([
      { geometry: dead, roadMiles: 4 },
      { geometry: loaded, roadMiles: 10 },
    ]);
    expect(m.geometry.length).toBe(13); // joint de-duplicated
    expect(measurePoint(m, dead[1]!)!.roadMiles).toBeCloseTo(2, 1);
    expect(measurePoint(m, loaded[5]!)!.roadMiles).toBeCloseTo(9, 1);
  });

  it("off the line is off route", () => {
    const m = buildRouteMeasure([{ geometry: line(10), roadMiles: 0 }]);
    expect(measurePoint(m, { lat: 30.05, lng: -81 })!.onRoute).toBe(false);
  });

  it("finds the point and the direction of travel at a mark", () => {
    const m = buildRouteMeasure([{ geometry: line(10), roadMiles: 0 }]);
    expect(pointAtRoadMiles(m, 2.5)!.lat).toBeCloseTo(30 + 2.5 * 0.01449, 4);
    expect(headingAtRoadMiles(m, 2.5)).toBeCloseTo(0, 0);
    expect(bearingDeg({ lat: 30, lng: -82 }, { lat: 30, lng: -81 })).toBeCloseTo(90, 0);
  });
});
