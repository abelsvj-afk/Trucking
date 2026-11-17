import { describe, expect, it } from "vitest";
import {
  bridgeItems,
  clearanceClass,
  formatHeightIn,
  parseMaxHeight,
} from "@/lib/smart-path-bridges";

describe("parseMaxHeight", () => {
  it("parses meters, the OSM default", () => {
    expect(parseMaxHeight("4.2")).toBeCloseTo(165.4, 0);
    expect(parseMaxHeight("4.2 m")).toBeCloseTo(165.4, 0);
    expect(parseMaxHeight("3.5")).toBeCloseTo(137.8, 0);
  });
  it("parses feet and inches as US mappers write them", () => {
    expect(parseMaxHeight("13'6\"")).toBe(162);
    expect(parseMaxHeight("13 ft 6 in")).toBe(162);
    expect(parseMaxHeight("14'")).toBe(168);
    expect(parseMaxHeight("13.5 ft")).toBe(162);
  });
  it("returns null instead of guessing", () => {
    expect(parseMaxHeight("")).toBeNull();
    expect(parseMaxHeight("unknown")).toBeNull();
    expect(parseMaxHeight("99")).toBeNull();
    expect(parseMaxHeight("13'6\" x")).toBeNull();
  });
});

describe("formatHeightIn", () => {
  it("reads like a driver reads it", () => {
    expect(formatHeightIn(162)).toBe(`13'6"`);
    expect(formatHeightIn(168)).toBe(`14'0"`);
  });
});

describe("clearanceClass", () => {
  it("below, tight within 6 inches, ok above", () => {
    expect(clearanceClass(160, 162)).toBe("below");
    expect(clearanceClass(162, 162)).toBe("tight");
    expect(clearanceClass(167, 162)).toBe("tight");
    expect(clearanceClass(169, 162)).toBe("ok");
    expect(clearanceClass(null, 162)).toBe("unknown");
    expect(clearanceClass(162, null)).toBe("unknown");
  });
});

describe("bridgeItems", () => {
  const corridor = [
    { mile: 0, lat: 35, lng: -90, etaAt: "2026-11-17T12:00:00-06:00" },
    { mile: 50, lat: 35.72, lng: -90, etaAt: "2026-11-17T13:00:00-06:00" },
    { mile: 100, lat: 36.45, lng: -90, etaAt: "2026-11-17T14:00:00-06:00" },
  ];
  it("warns below his height and flags tight ones, in mile order", () => {
    const items = bridgeItems(
      [
        { id: "b1", point: { lat: 36.4, lng: -90 }, maxHeightIn: 168, name: null, road: "I-55" },
        { id: "b2", point: { lat: 35.7, lng: -90 }, maxHeightIn: 160, name: "Low bridge", road: null },
      ],
      corridor,
      162,
    );
    expect(items).toHaveLength(2);
    expect(items[0]!.id).toBe("b2");
    expect(items[0]!.clearance).toBe("below");
    expect(items[0]!.text).toContain("UNDER your truck");
    expect(items[1]!.clearance).toBe("tight");
    expect(items[1]!.text).toContain("only just over your truck");
  });
  it("drops a bridge far from the route and one at an untimed point", () => {
    const items = bridgeItems(
      [
        { id: "far", point: { lat: 40, lng: -80 }, maxHeightIn: 160, name: null, road: null },
        { id: "untimed", point: { lat: 35.1, lng: -90 }, maxHeightIn: 160, name: null, road: null },
      ],
      [{ mile: 0, lat: 35, lng: -90, etaAt: null }],
      162,
    );
    expect(items).toEqual([]);
  });
  it("a bridge with no recorded clearance is unknown, never a pass", () => {
    const items = bridgeItems(
      [{ id: "b", point: { lat: 35.7, lng: -90 }, maxHeightIn: null, name: null, road: "I-55" }],
      corridor,
      162,
    );
    expect(items[0]!.clearance).toBe("unknown");
    expect(items[0]!.text).toContain("not a pass");
  });
});
