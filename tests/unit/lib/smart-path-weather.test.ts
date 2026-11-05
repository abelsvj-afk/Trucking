import { describe, expect, it } from "vitest";
import { mergeStretches, weatherItemsForPoint } from "@/lib/smart-path-weather";
import { maxMph, parseAlerts, parseHourly } from "@/services/integrations/nws-route";

const eta = new Date("2026-11-06T15:00:00Z");
const hour = (over: Record<string, unknown> = {}) => ({
  startTime: "2026-11-06T14:00:00Z", endTime: "2026-11-06T16:00:00Z", windMph: 10, gustMph: null, shortForecast: "Sunny", precipChancePct: 0, tempF: 60, ...over,
});

describe("nws parsing", () => {
  it("reads the larger number of a wind range", () => {
    expect(maxMph("10 to 20 mph")).toBe(20);
    expect(maxMph("15 mph")).toBe(15);
    expect(maxMph("calm")).toBeNull();
    expect(maxMph(null)).toBeNull();
  });
  it("rejects a wrong shape instead of guessing", () => {
    expect(() => parseHourly({ nope: 1 })).toThrow();
    expect(() => parseAlerts({ features: [{ properties: {} }] })).toThrow();
  });
});

describe("weatherItemsForPoint", () => {
  it("warns on wind at his arrival time", () => {
    const items = weatherItemsForPoint(120, eta, [hour({ windMph: 38, gustMph: 50 })], []);
    expect(items.map((i) => i.kind)).toEqual(["wind"]);
    expect(items[0]!.text).toContain("38 mph");
  });
  it("uses the period he actually arrives in, not another", () => {
    const later = hour({ startTime: "2026-11-06T20:00:00Z", endTime: "2026-11-06T21:00:00Z", windMph: 60 });
    expect(weatherItemsForPoint(0, eta, [later], [])).toEqual([]);
  });
  it("drops an alert that ends before he gets there or starts after", () => {
    const ended = { event: "Winter Storm Warning", severity: "Severe", headline: "h", onset: "2026-11-06T00:00:00Z", ends: "2026-11-06T10:00:00Z" };
    const future = { event: "Winter Storm Warning", severity: "Severe", headline: "h", onset: "2026-11-07T00:00:00Z", ends: "2026-11-07T10:00:00Z" };
    const live = { event: "High Wind Warning", severity: "Severe", headline: "gusts", onset: "2026-11-06T12:00:00Z", ends: "2026-11-06T20:00:00Z" };
    const items = weatherItemsForPoint(5, eta, [], [ended, future, live]);
    expect(items).toHaveLength(1);
    expect(items[0]!.severe).toBe(true);
  });
  it("ignores alert types a driver doesn't need a line for", () => {
    expect(weatherItemsForPoint(0, eta, [], [{ event: "Beach Hazards Statement", severity: "Minor", headline: null, onset: null, ends: null }])).toEqual([]);
  });
  it("flags ice and cold", () => {
    const kinds = weatherItemsForPoint(0, eta, [hour({ shortForecast: "Freezing Rain", tempF: 10 })], []).map((i) => i.kind);
    expect(kinds).toEqual(["ice", "cold"]);
  });
});

describe("mergeStretches", () => {
  it("merges the same warning at neighboring points into one stretch", () => {
    const base = { etaAt: "x", kind: "wind" as const, severe: false, text: "t", source: "NWS" as const };
    const merged = mergeStretches([{ ...base, mile: 100 }, { ...base, mile: 110 }, { ...base, mile: 120 }, { ...base, mile: 400 }]);
    expect(merged.map((m) => [m.mile, m.endMile])).toEqual([[100, 120], [400, 400]]);
  });
});
