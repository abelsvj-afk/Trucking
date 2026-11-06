import { describe, expect, it } from "vitest";
import { truckIconSvg } from "@/lib/truck-icon";
import { bearingDeg, distanceM, nextHeading } from "@/lib/heading";
import { routeProgress, ON_ROUTE_MILES } from "@/lib/route-progress";
import { limitIsShowable, shouldQuerySpeedLimit, LIMIT_FRESH_MS, MIN_GAP_MS } from "@/lib/speed-limit-policy";
import { parseMaxspeed, pickSpeedLimit } from "@/services/integrations/osm-speed";
import { chooseActiveRoute, ROUTE_MAX_AGE_MS } from "@/lib/use-active-route";
import { serializeActivePlan } from "@/lib/drive";
import type { RouteCheckResponse } from "@/types/smart-path";

describe("truck icon", () => {
  it("is a vector semi truck: cab + trailer, taller than wide, in the requested colour, with a white outline", () => {
    const svg = truckIconSvg({ color: "#2563eb", widthPx: 26 });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('viewBox="0 0 32 88"');
    expect(svg).toContain('height="72"'); // 26 * 2.75
    expect(svg).toContain("#2563eb");
    expect(svg).toContain('fill="#fff"'); // outline
    expect((svg.match(/<rect/g) ?? []).length).toBeGreaterThanOrEqual(10); // cab, windshield, mirrors, trailer, tires...
  });
  it("a lost fix is faded, never drawn as live", () => {
    expect(truckIconSvg({ color: "#9ca3af", opacity: 0.55 })).toContain("opacity:0.55");
  });
});

describe("heading", () => {
  const A = { lat: 28, lng: -81 };
  it("bearings: north, east, south, west", () => {
    expect(Math.round(bearingDeg(A, { lat: 28.01, lng: -81 }))).toBe(0);
    expect(Math.round(bearingDeg(A, { lat: 28, lng: -80.99 }))).toBe(90);
    expect(Math.round(bearingDeg(A, { lat: 27.99, lng: -81 }))).toBe(180);
    expect(Math.round(bearingDeg(A, { lat: 28, lng: -81.01 }))).toBe(270);
  });
  it("trusts the phone's heading only while actually moving", () => {
    const b = { lat: 28.0001, lng: -81 };
    expect(nextHeading({ previous: A, current: b, reportedDeg: 123, speedMph: 40, held: 10 })).toBe(123);
    expect(nextHeading({ previous: A, current: b, reportedDeg: 123, speedMph: 0.5, held: 10 })).toBe(10);
  });
  it("derives a heading from real movement when the phone gives none", () => {
    const moved = { lat: 28.001, lng: -81 }; // ~111 m north
    expect(distanceM(A, moved)).toBeGreaterThan(100);
    expect(Math.round(nextHeading({ previous: A, current: moved, reportedDeg: null, speedMph: 30, held: null })!)).toBe(0);
  });
  it("holds the last heading through a standstill's wobble (no spinning icon) and starts unknown", () => {
    const wobble = { lat: 28.00005, lng: -81.00003 }; // ~6 m
    expect(nextHeading({ previous: A, current: wobble, reportedDeg: null, speedMph: 0, held: 200 })).toBe(200);
    expect(nextHeading({ previous: null, current: A, reportedDeg: null, speedMph: null, held: null })).toBeNull();
  });
});

describe("route progress", () => {
  const line = Array.from({ length: 11 }, (_, i) => ({ lat: 28 + i * 0.1, lng: -81 })); // ~69 mi
  it("measures miles done / left and splits the line at the truck", () => {
    const p = routeProgress({ lat: 28.5, lng: -81.0001 }, line)!;
    expect(p.onRoute).toBe(true);
    expect(p.fraction!).toBeCloseTo(0.5, 1);
    expect(p.milesDone! + p.milesLeft!).toBeCloseTo(p.totalMiles, 5);
    expect(p.traveled.length).toBe(6);
    expect(p.ahead.length).toBe(6);
  });
  it("off the line: no progress is claimed", () => {
    const p = routeProgress({ lat: 28.5, lng: -80.5 }, line)!;
    expect(p.onRoute).toBe(false);
    expect(p.offRouteMiles).toBeGreaterThan(ON_ROUTE_MILES);
    expect(p.milesDone).toBeNull();
    expect(p.traveled).toEqual([]);
  });
  it("no route -> null (nothing invented)", () => {
    expect(routeProgress({ lat: 28, lng: -81 }, [])).toBeNull();
    expect(routeProgress({ lat: 28, lng: -81 }, [{ lat: 28, lng: -81 }])).toBeNull();
  });
});

describe("posted speed limit (OSM maxspeed) - never estimated", () => {
  it("parses only plain numeric limits", () => {
    expect(parseMaxspeed("55 mph")).toBe(55);
    expect(parseMaxspeed("65mph")).toBe(65);
    expect(parseMaxspeed("100")).toBe(62); // unitless OSM is km/h
    for (const bad of ["none", "signals", "walk", "US:urban", "55;65", "", undefined, "0", "300 mph"]) expect(parseMaxspeed(bad as string | undefined)).toBeNull();
  });
  const way = (id: number, tags: Record<string, string>, geometry: { lat: number; lon: number }[]) => ({ type: "way", id, tags, geometry });
  const north = [{ lat: 28.0, lon: -81.0 }, { lat: 28.002, lon: -81.0 }];
  const here = { lat: 28.001, lng: -81.00005 };
  it("picks the tagged way the truck is on", () => {
    const r = pickSpeedLimit({ elements: [way(1, { highway: "primary", maxspeed: "45 mph", name: "Main St" }, north)] }, here, 0);
    expect(r).toEqual({ mph: 45, wayId: 1, roadName: "Main St" });
  });
  it("no tagged way, an untagged/odd tag, or a way too far -> null (no badge)", () => {
    expect(pickSpeedLimit({ elements: [] }, here, 0)).toBeNull();
    expect(pickSpeedLimit({ elements: [way(1, { highway: "primary" }, north)] }, here, 0)).toBeNull();
    expect(pickSpeedLimit({ elements: [way(1, { highway: "primary", maxspeed: "signals" }, north)] }, here, 0)).toBeNull();
    expect(pickSpeedLimit({ elements: [way(1, { highway: "primary", maxspeed: "45 mph" }, north)] }, { lat: 28.001, lng: -81.01 }, 0)).toBeNull();
  });
  it("with a heading, ignores a cross street and takes the road it is travelling along", () => {
    const cross = [{ lat: 28.001, lon: -81.0005 }, { lat: 28.001, lon: -80.9995 }];
    const r = pickSpeedLimit({ elements: [way(2, { highway: "residential", maxspeed: "25 mph" }, cross), way(1, { highway: "primary", maxspeed: "55 mph" }, north)] }, here, 0);
    expect(r?.mph).toBe(55);
    expect(pickSpeedLimit({ elements: [way(2, { highway: "residential", maxspeed: "25 mph" }, cross)] }, here, 0)).toBeNull();
  });
  it("garbage from the service is no limit, not a crash", () => {
    expect(pickSpeedLimit({ nope: 1 }, here, 0)).toBeNull();
  });
});

describe("speed-limit policy", () => {
  const P = { lat: 28, lng: -81 };
  it("asks first, then only after real movement or time, never faster than the minimum gap, never while parked", () => {
    expect(shouldQuerySpeedLimit(null, 0, P, false)).toBe(true);
    const last = { atMs: 0, point: P };
    expect(shouldQuerySpeedLimit(last, MIN_GAP_MS - 1, { lat: 28.01, lng: -81 }, true)).toBe(false);
    expect(shouldQuerySpeedLimit(last, MIN_GAP_MS + 1, { lat: 28.01, lng: -81 }, true)).toBe(true);
    expect(shouldQuerySpeedLimit(last, 60_000, P, false)).toBe(false);
  });
  it("a limit is shown only while fresh and near where it was looked up", () => {
    const res = { limitMph: 55, lookup: { atMs: 0, point: P } };
    expect(limitIsShowable(res, 1000, P)).toBe(55);
    expect(limitIsShowable(res, LIMIT_FRESH_MS + 1, P)).toBeNull();
    expect(limitIsShowable(res, 1000, { lat: 28.02, lng: -81 })).toBeNull(); // moved on ~2 km
    expect(limitIsShowable({ limitMph: null, lookup: res.lookup }, 1000, P)).toBeNull();
    expect(limitIsShowable(null, 0, P)).toBeNull();
    expect(limitIsShowable(res, 1000, null)).toBeNull();
  });
});

describe("active route for the Home map", () => {
  const geometry = Array.from({ length: 11 }, (_, i) => ({ lat: 28 + i * 0.5, lng: -81.7 }));
  const result = {
    load: { id: "load-1", origin: "A", destination: "Atlanta, GA", status: "confirmed" },
    route: { provider: "valhalla", truckLegal: true, distanceMiles: 100, providerDurationMinutes: 120, geometry, originPoint: geometry[0]!, destinationPoint: geometry[10]!, maneuvers: [] },
    clocks: null,
    verdict: { status: "on_time", assumedDriveMinutes: 120, driveTimeBasis: "provider", legalLines: [], restedLines: [], lifeLines: [], paidLines: [], tradeoffLines: [], makeItDepartureAt: null, leaveStartByAt: null },
    plan: null, deadhead: null,
    fuel: { assumptions: { gallonsToBuy: 0, avgMpg: 6, valueOfTimeCentsPerHour: 0, stopMinutes: 0, baselinePriceCents: null }, candidates: [], unavailableReason: null },
    food: { mode: "grocery", groceryPlan: null, stops: [], suppressedByFast: [], lines: [], unavailableReason: null },
    warnings: [],
  } as unknown as RouteCheckResponse;
  const NOW = 1_000_000_000_000;
  const raw = serializeActivePlan(result, NOW - 3_600_000);
  it("draws the route for a confirmed load", () => {
    const r = chooseActiveRoute(raw, NOW, "confirmed");
    expect(r?.geometry.length).toBe(11);
    expect(r?.destinationLabel).toContain("Atlanta");
  });
  it("no route when there is none, the load is done/cancelled/unknown, or the plan is stale - nothing invented", () => {
    expect(chooseActiveRoute(null, NOW, "confirmed")).toBeNull();
    expect(chooseActiveRoute("not json", NOW, "confirmed")).toBeNull();
    for (const status of ["completed", "cancelled", "draft", null]) expect(chooseActiveRoute(raw, NOW, status)).toBeNull();
    expect(chooseActiveRoute(raw, NOW + ROUTE_MAX_AGE_MS, "confirmed")).toBeNull();
  });
});
