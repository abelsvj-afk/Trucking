// Route progress is measured from the truck's PROJECTION onto the
// line, not from the nearest vertex (owner 2026-11-17: the app said
// 11 mi to I-20, the other map said 19). Routing geometry is sparse
// on long straight stretches, so a vertex snap can put the truck
// miles ahead of where it really is — and every "miles to" number
// downstream inherits the error.

import { describe, expect, it } from "vitest";
import { routeProgress } from "@/lib/route-progress";

const MI = 1 / 69.05; // one mile in degrees of latitude
// A straight north-south road: vertices 16 mi apart (sparse, like a
// long interstate stretch between shape points).
const sparse = [
  { lat: 30, lng: -90 },
  { lat: 30 + 16 * MI, lng: -90 },
  { lat: 30 + 32 * MI, lng: -90 },
];

describe("routeProgress — projection, not vertex snap", () => {
  it("a truck mid-segment is ON the route with the right miles done (the old vertex snap called it 8 mi off-route)", () => {
    const p = routeProgress({ lat: 30 + 8 * MI, lng: -90 }, sparse)!;
    expect(p.onRoute).toBe(true);
    expect(p.offRouteMiles).toBeCloseTo(0, 2);
    expect(p.milesDone).toBeCloseTo(8, 1);
    expect(p.milesLeft).toBeCloseTo(24, 1);
    expect(p.fraction).toBeCloseTo(0.25, 2);
  });

  it("the ahead line starts exactly where the truck is, not at the next vertex", () => {
    const p = routeProgress({ lat: 30 + 8 * MI, lng: -90 }, sparse)!;
    expect(p.ahead[0]!.lat).toBeCloseTo(30 + 8 * MI, 4);
    expect(p.ahead[0]!.lng).toBeCloseTo(-90, 4);
    expect(p.traveled[p.traveled.length - 1]!.lat).toBeCloseTo(30 + 8 * MI, 4);
  });

  it("a truck 1.4 mi short of a vertex counts the 1.4 mi, not the vertex (the old snap overstated miles done)", () => {
    const p = routeProgress({ lat: 30 + 14.6 * MI, lng: -90 }, sparse)!;
    expect(p.onRoute).toBe(true);
    expect(p.milesDone).toBeCloseTo(14.6, 1);
    expect(p.milesLeft).toBeCloseTo(17.4, 1);
  });

  it("dense geometry behaves as before: a truck on a vertex splits at that vertex", () => {
    const dense = Array.from({ length: 11 }, (_, i) => ({ lat: 28 + i * 0.1, lng: -81 }));
    const p = routeProgress({ lat: 28.5, lng: -81.0001 }, dense)!;
    expect(p.onRoute).toBe(true);
    expect(p.fraction).toBeCloseTo(0.5, 1);
    expect(p.traveled.length).toBe(6);
    expect(p.ahead.length).toBe(6);
  });

  it("off the line: no progress is claimed", () => {
    // 3 mi east of the line (a degree of longitude is shorter than a degree of latitude).
    const east3mi = 3 / (69.05 * Math.cos((30 * Math.PI) / 180));
    const p = routeProgress({ lat: 30 + 8 * MI, lng: -90 + east3mi }, sparse)!;
    expect(p.onRoute).toBe(false);
    expect(p.offRouteMiles).toBeCloseTo(3, 1);
    expect(p.milesDone).toBeNull();
    expect(p.traveled).toEqual([]);
  });
});
