import { describe, expect, it } from "vitest";
import {
  interpolateAlongRoute,
  lerpPoint,
  milesAlongRoute,
} from "@/lib/drive-position-smoothing";

// A straight northbound line: ~1 mile per 0.01449 degrees of latitude.
const line = (miles: number) =>
  Array.from({ length: miles + 1 }, (_, i) => ({ lat: 30 + i * 0.01449, lng: -82 }));

describe("milesAlongRoute", () => {
  it("measures miles along the line, not to the nearest vertex", () => {
    const geometry = line(10);
    // Halfway between the 3- and 4-mile vertices.
    expect(milesAlongRoute({ lat: 30 + 3.5 * 0.01449, lng: -82 }, geometry)).toBeCloseTo(3.5, 1);
  });

  it("returns null off the line — no progress is claimed there", () => {
    expect(milesAlongRoute({ lat: 31, lng: -82 }, line(10))).toBeNull();
  });
});

describe("lerpPoint", () => {
  it("blends between two fixes and clamps", () => {
    expect(lerpPoint({ lat: 0, lng: 0 }, { lat: 10, lng: 20 }, 0.5)).toEqual({ lat: 5, lng: 10 });
    expect(lerpPoint({ lat: 0, lng: 0 }, { lat: 10, lng: 20 }, 2)).toEqual({ lat: 10, lng: 20 });
  });
});

describe("interpolateAlongRoute", () => {
  const geometry = line(10);
  const from = { lat: 30 + 2 * 0.01449, lng: -82 };
  const to = { lat: 30 + 4 * 0.01449, lng: -82 };

  it("glides along the line between two mile marks", () => {
    const mid = interpolateAlongRoute(geometry, from, to, 2, 4, 0.5)!;
    // 3 decimals: the test line's "1 mile per 0.01449 degrees" is
    // itself approximate to ~7e-5 degrees, so 4 decimals over-claims.
    expect(mid.lat).toBeCloseTo(30 + 3 * 0.01449, 3);
    expect(mid.lng).toBe(-82);
    expect(interpolateAlongRoute(geometry, from, to, 2, 4, 0)!.lat).toBeCloseTo(from.lat, 3);
    expect(interpolateAlongRoute(geometry, from, to, 2, 4, 1)!.lat).toBeCloseTo(to.lat, 3);
  });

  it("never runs past the newest fix", () => {
    expect(interpolateAlongRoute(geometry, from, to, 2, 4, 5)!.lat).toBeCloseTo(to.lat, 3);
  });

  it("falls back to a straight lerp off route", () => {
    const off = { lat: 31, lng: -83 };
    expect(interpolateAlongRoute(geometry, from, off, null, null, 0.5)).toEqual(lerpPoint(from, off, 0.5));
  });

  it("returns null without geometry", () => {
    expect(interpolateAlongRoute([], from, to, 2, 4, 0.5)).toBeNull();
  });
});
