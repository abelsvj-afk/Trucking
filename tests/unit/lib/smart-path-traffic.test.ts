import { describe, expect, it } from "vitest";
import {
  avoidCirclesFor,
  evaluateTrafficCall,
  mapIncidentsToRoute,
  severityOf,
  trafficSegments,
  type TrafficIncident,
  type TrafficItem,
} from "@/lib/smart-path-traffic";

// A straight route: 100 miles due north from (35, -90), ~1.45 deg lat.
const GEOMETRY = Array.from({ length: 101 }, (_, i) => ({
  lat: 35 + i * 0.01449,
  lng: -90,
}));
const TIMING = [
  { mile: 0, etaAt: "2026-11-17T12:00:00-06:00" },
  { mile: 50, etaAt: "2026-11-17T13:00:00-06:00" },
  { mile: 100, etaAt: "2026-11-17T14:00:00-06:00" },
];

function incident(partial: Partial<TrafficIncident>): TrafficIncident {
  return {
    id: "inc-1",
    iconCategory: 6,
    description: "Queue",
    points: [{ lat: 35 + 40 * 0.01449, lng: -90 }],
    delaySeconds: 1500,
    magnitude: 3,
    startTime: null,
    endTime: null,
    from: "A",
    to: "B",
    lengthMeters: 3000,
    roadNumbers: ["I-55"],
    ...partial,
  };
}

describe("severityOf", () => {
  it("magnitude 3+ is severe, 2 is moderate, 1 is minor", () => {
    expect(severityOf(3, null)).toBe("severe");
    expect(severityOf(4, 0)).toBe("severe");
    expect(severityOf(2, null)).toBe("moderate");
    expect(severityOf(1, null)).toBe("minor");
    expect(severityOf(0, null)).toBe("minor");
  });
  it("a long delay makes it severe even at low magnitude", () => {
    expect(severityOf(1, 30)).toBe("severe");
    expect(severityOf(0, 12)).toBe("moderate");
    expect(severityOf(0, 5)).toBe("minor");
  });
});

describe("mapIncidentsToRoute", () => {
  it("maps an on-route incident to its mile, with color and delay", () => {
    const items = mapIncidentsToRoute([incident({})], GEOMETRY, TIMING);
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe("severe");
    expect(items[0]!.color).toBe("#dc2626");
    expect(items[0]!.delayMinutes).toBe(25);
    expect(items[0]!.mile).toBeGreaterThan(35);
    expect(items[0]!.mile).toBeLessThan(45);
    expect(items[0]!.etaAt).toBe("2026-11-17T13:00:00-06:00");
    expect(items[0]!.text).toContain("Traffic jam");
    expect(items[0]!.text).toContain("I-55");
  });
  it("drops an incident far from the route and one with no points", () => {
    const far = incident({ id: "far", points: [{ lat: 40, lng: -80 }] });
    const noPoints = incident({ id: "empty", points: [] });
    expect(mapIncidentsToRoute([far, noPoints], GEOMETRY, TIMING)).toEqual([]);
  });
  it("a minor incident is listed with no color", () => {
    const items = mapIncidentsToRoute(
      [incident({ iconCategory: 9, magnitude: 1, delaySeconds: 120 })],
      GEOMETRY,
      TIMING,
    );
    expect(items[0]!.severity).toBe("minor");
    expect(items[0]!.color).toBeNull();
  });
  it("returns nothing for a degenerate geometry", () => {
    expect(mapIncidentsToRoute([incident({})], [], TIMING)).toEqual([]);
  });
});

describe("trafficSegments", () => {
  it("merges overlapping same-color stretches, keeps colors apart", () => {
    const items: TrafficItem[] = [
      { id: "a", mile: 10, endMile: 20, etaAt: null, category: "Traffic jam", severity: "severe", color: "#dc2626", delayMinutes: 30, text: "", startsAt: null, endsAt: null, from: null, to: null, roadNumbers: [] },
      { id: "b", mile: 19, endMile: 25, etaAt: null, category: "Traffic jam", severity: "severe", color: "#dc2626", delayMinutes: 30, text: "", startsAt: null, endsAt: null, from: null, to: null, roadNumbers: [] },
      { id: "c", mile: 40, endMile: 45, etaAt: null, category: "Traffic jam", severity: "moderate", color: "#ea580c", delayMinutes: 12, text: "", startsAt: null, endsAt: null, from: null, to: null, roadNumbers: [] },
      { id: "d", mile: 60, endMile: 62, etaAt: null, category: "Road work", severity: "minor", color: null, delayMinutes: 3, text: "", startsAt: null, endsAt: null, from: null, to: null, roadNumbers: [] },
    ];
    expect(trafficSegments(items)).toEqual([
      { fromMile: 10, toMile: 25, color: "#dc2626" },
      { fromMile: 40, toMile: 45, color: "#ea580c" },
    ]);
  });
});

describe("avoidCirclesFor", () => {
  it("builds a circle around each colored item, capped at five", () => {
    const items = mapIncidentsToRoute(
      [incident({}), incident({ id: "i2", points: [{ lat: 35 + 70 * 0.01449, lng: -90 }] })],
      GEOMETRY,
      TIMING,
    );
    const circles = avoidCirclesFor(items, GEOMETRY, 100);
    expect(circles).toHaveLength(2);
    expect(circles[0]!.radiusMiles).toBeGreaterThanOrEqual(3);
    expect(Math.abs(circles[0]!.lat - (35 + 40 * 0.01449))).toBeLessThan(0.05);
  });
});

describe("evaluateTrafficCall", () => {
  const worst = (partial: Partial<TrafficItem> = {}): TrafficItem => ({
    id: "inc-1",
    mile: 40,
    endMile: 43,
    etaAt: "2026-11-17T13:00:00-06:00",
    category: "Traffic jam",
    severity: "severe",
    color: "#dc2626",
    delayMinutes: 30,
    text: "",
    startsAt: null,
    endsAt: "2026-11-17T12:30:00-06:00",
    from: null,
    to: null,
    roadNumbers: [],
    ...partial,
  });

  it("says none when nothing ahead", () => {
    const call = evaluateTrafficCall({
      itemsAhead: [],
      currentMile: 0,
      etaAtIncident: null,
      detour: null,
      plannedRemainingMinutes: 120,
      now: new Date("2026-11-17T12:00:00-06:00"),
    });
    expect(call.decision).toBe("none");
  });
  it("says stay when the incident clears before he gets there", () => {
    const call = evaluateTrafficCall({
      itemsAhead: [worst()],
      currentMile: 0,
      etaAtIncident: "2026-11-17T13:00:00-06:00",
      detour: null,
      plannedRemainingMinutes: 120,
      now: new Date("2026-11-17T12:00:00-06:00"),
    });
    expect(call.decision).toBe("stay");
    expect(call.reason).toContain("clear before you get there");
  });
  it("says reroute when the truck-checked detour saves 10+ min", () => {
    const call = evaluateTrafficCall({
      itemsAhead: [worst({ endsAt: "2026-11-17T14:00:00-06:00" })],
      currentMile: 0,
      etaAtIncident: "2026-11-17T13:00:00-06:00",
      detour: { durationMinutes: 135, distanceMiles: 110 },
      plannedRemainingMinutes: 120,
      now: new Date("2026-11-17T12:00:00-06:00"),
    });
    expect(call.decision).toBe("reroute");
    expect(call.savesMinutes).toBe(15);
    expect(call.reason).toContain("saves about 15 min");
  });
  it("says stay when the detour barely helps", () => {
    const call = evaluateTrafficCall({
      itemsAhead: [worst({ endsAt: "2026-11-17T14:00:00-06:00" })],
      currentMile: 0,
      etaAtIncident: "2026-11-17T13:00:00-06:00",
      detour: { durationMinutes: 145, distanceMiles: 110 },
      plannedRemainingMinutes: 120,
      now: new Date("2026-11-17T12:00:00-06:00"),
    });
    expect(call.decision).toBe("stay");
    expect(call.savesMinutes).toBe(5);
  });
  it("says stay with the reason when no detour could be compared", () => {
    const call = evaluateTrafficCall({
      itemsAhead: [worst({ endsAt: "2026-11-17T14:00:00-06:00" })],
      currentMile: 0,
      etaAtIncident: "2026-11-17T13:00:00-06:00",
      detour: null,
      plannedRemainingMinutes: 120,
      now: new Date("2026-11-17T12:00:00-06:00"),
    });
    expect(call.decision).toBe("stay");
    expect(call.reason).toContain("no truck-checked detour");
  });
  it("ignores minor incidents for the call", () => {
    const minor = worst({ severity: "minor", color: null, delayMinutes: 4 });
    const call = evaluateTrafficCall({
      itemsAhead: [minor],
      currentMile: 0,
      etaAtIncident: null,
      detour: null,
      plannedRemainingMinutes: 120,
      now: new Date("2026-11-17T12:00:00-06:00"),
    });
    expect(call.decision).toBe("none");
  });
});
