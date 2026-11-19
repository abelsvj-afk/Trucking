// Smooth driving (owner 2026-11-19): the truck glides between fixes,
// turns the short way, rolls its tires by the ground covered, and
// stops asking for frames once it reaches the fix.
import { describe, expect, it } from "vitest";
import { buildRouteMeasure } from "@/lib/route-measure";
import { feedFix, lerpHeading, sampleMotion, TIRE_RADIUS_M, type TruckPose } from "@/lib/truck-motion";

const A: TruckPose = { position: { lat: 35, lng: -80 }, headingDeg: 90 };
// ~91 m east of A
const B: TruckPose = { position: { lat: 35, lng: -79.999 }, headingDeg: 90 };

describe("truck motion", () => {
  it("draws the first fix where it is, without gliding", () => {
    const m = feedFix(null, A, 0);
    const { frame } = sampleMotion(m, 0);
    expect(frame.pose).toEqual(A);
    expect(frame.animating).toBe(false);
  });

  it("glides to a new fix over the time between fixes, then stops animating", () => {
    let m = feedFix(null, A, 0);
    m = sampleMotion(m, 0).motion;
    m = feedFix(m, B, 1000); // fix gap 1 s -> 1 s glide
    const mid = sampleMotion(m, 1500);
    expect(mid.frame.animating).toBe(true);
    expect(mid.frame.pose.position.lng).toBeGreaterThan(A.position.lng);
    expect(mid.frame.pose.position.lng).toBeLessThan(B.position.lng);
    const end = sampleMotion(mid.motion, 2000);
    expect(end.frame.animating).toBe(false);
    expect(end.frame.pose.position).toEqual(B.position);
  });

  it("re-reading the same fix every frame does not restart the glide", () => {
    let m = feedFix(null, A, 0);
    m = feedFix(m, B, 1000);
    expect(feedFix(m, B, 1200)).toBe(m);
  });

  it("rolls the tires by the distance covered (distance / radius)", () => {
    let m = feedFix(null, A, 0);
    m = feedFix(m, B, 1000);
    const end = sampleMotion(m, 5000);
    // a short step (~0.9 m) so the roll is well under one turn and checkable directly
    let n = feedFix(null, A, 0);
    const near: TruckPose = { position: { lat: 35, lng: -79.99999 }, headingDeg: 90 };
    n = feedFix(n, near, 1000);
    const short = sampleMotion(n, 5000);
    const meters = 0.00001 * 111_195 * Math.cos((35 * Math.PI) / 180);
    expect(short.frame.wheelAngle).toBeCloseTo(meters / TIRE_RADIUS_M, 1);
    expect(end.frame.wheelAngle).not.toBe(0);
  });

  it("parked: no movement, no tire roll, no frames", () => {
    let m = feedFix(null, A, 0);
    m = feedFix(m, A, 5000);
    const { frame } = sampleMotion(m, 5000);
    expect(frame.wheelAngle).toBe(0);
    expect(frame.animating).toBe(false);
  });

  it("snaps instead of gliding across the map on a teleport (>2 km)", () => {
    let m = feedFix(null, A, 0);
    m = feedFix(m, { position: { lat: 36, lng: -80 }, headingDeg: 0 }, 1000);
    const { frame } = sampleMotion(m, 1000);
    expect(frame.pose.position.lat).toBe(36);
    expect(frame.animating).toBe(false);
  });

  it("turns the short way round through north", () => {
    expect(lerpHeading(350, 10, 0.5)).toBeCloseTo(0);
    expect(lerpHeading(10, 350, 0.5)).toBeCloseTo(0);
    expect(lerpHeading(90, 180, 0.5)).toBeCloseTo(135);
  });
});

describe("truck motion along the road (one motion system, 2026-11-19)", () => {
  // An L: north 1 mile, then east 1 mile.
  const L = [
    { lat: 30, lng: -82 },
    { lat: 30.01449, lng: -82 },
    { lat: 30.01449, lng: -81.9833 },
  ];
  const measure = buildRouteMeasure([{ geometry: L, roadMiles: 0 }]);

  it("follows the road through a corner instead of cutting across it", () => {
    let m = feedFix(null, { position: { lat: 30.007, lng: -82 }, headingDeg: 0 }, 0, measure);
    m = sampleMotion(m, 0).motion;
    m = feedFix(m, { position: { lat: 30.01449, lng: -81.991 }, headingDeg: null }, 1000, measure);
    // Mid-glide the truck is ON the line (either leg), not on the diagonal chord.
    const mid = sampleMotion(m, 1350).frame.pose.position;
    const onNorthLeg = Math.abs(mid.lng - -82) < 1e-6;
    const onEastLeg = Math.abs(mid.lat - 30.01449) < 1e-6;
    expect(onNorthLeg || onEastLeg).toBe(true);
  });

  it("points the nose the way it is travelling, even when the GPS heading is missing or wrong", () => {
    let m = feedFix(null, { position: { lat: 30.002, lng: -82 }, headingDeg: 180 }, 0, measure);
    m = sampleMotion(m, 0).motion;
    m = feedFix(m, { position: { lat: 30.006, lng: -82 }, headingDeg: 180 }, 1000, measure);
    expect(sampleMotion(m, 5000).frame.pose.headingDeg).toBeCloseTo(0, 0); // north, the road's way
    // Off the route: the bearing between the fixes
    let n = feedFix(null, { position: { lat: 31, lng: -80 }, headingDeg: null }, 0);
    n = sampleMotion(n, 0).motion;
    n = feedFix(n, { position: { lat: 31, lng: -79.999 }, headingDeg: null }, 1000);
    expect(sampleMotion(n, 5000).frame.pose.headingDeg).toBeCloseTo(90, 0);
  });
});

describe("the truck follows HIS GPS, not the route line (owner 2026-11-19)", () => {
  it("off the route (but within a mile of the line) the truck is drawn at his real position", async () => {
    const { buildRouteMeasure } = await import("@/lib/route-measure");
    // Route runs north along lng -82; he is on a parallel road 0.4 mi east.
    const line = Array.from({ length: 11 }, (_, i) => ({ lat: 30 + i * 0.01449, lng: -82 }));
    const measure = buildRouteMeasure([{ geometry: line, roadMiles: 0 }]);
    const east = -82 + 0.4 / 59.9;
    let m = feedFix(null, { position: { lat: 30.01, lng: east }, headingDeg: 0 }, 0, measure);
    m = sampleMotion(m, 0).motion;
    m = feedFix(m, { position: { lat: 30.02, lng: east }, headingDeg: 0 }, 1000, measure);
    const mid = sampleMotion(m, 1500).frame.pose.position;
    expect(mid.lng).toBeCloseTo(east, 6); // never pulled onto the route line
  });
});
