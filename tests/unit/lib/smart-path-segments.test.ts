import { describe, expect, it } from "vitest";
import {
  avoidCirclesToMultiPolygon,
  avoidCirclesToValhallaPolygons,
  circleToPolygonRing,
} from "@/lib/smart-path-avoid";
import { segmentsToFeatureCollection, sliceGeometry, sliceGeometryFromFraction } from "@/lib/smart-path-map-segments";

describe("circleToPolygonRing", () => {
  it("is a closed ring around the center, roughly the right size", () => {
    const ring = circleToPolygonRing({ lat: 35, lng: -90, radiusMiles: 10 });
    expect(ring.length).toBe(17);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    // A vertex due north of center is ~10 miles away (~0.145 deg lat).
    const north = ring.reduce((best, p) => (p[1] > best[1] ? p : best));
    expect(north[1] - 35).toBeGreaterThan(0.13);
    expect(north[1] - 35).toBeLessThan(0.16);
  });
});

describe("avoidCirclesToMultiPolygon", () => {
  it("wraps circles as a GeoJSON MultiPolygon", () => {
    const mp = avoidCirclesToMultiPolygon([
      { lat: 35, lng: -90, radiusMiles: 5 },
      { lat: 36, lng: -91, radiusMiles: 3 },
    ]);
    expect(mp.type).toBe("MultiPolygon");
    expect(mp.coordinates).toHaveLength(2);
    expect(mp.coordinates[0]![0]).toHaveLength(17);
  });
});

describe("avoidCirclesToValhallaPolygons", () => {
  it("uses {lat, lon} rings", () => {
    const polys = avoidCirclesToValhallaPolygons([{ lat: 35, lng: -90, radiusMiles: 5 }]);
    expect(polys).toHaveLength(1);
    expect(polys[0]![0]![0]).toEqual({ lat: expect.any(Number), lon: expect.any(Number) });
    expect(polys[0]![0]).toHaveLength(17);
  });
});

// A straight route: 100 miles due north from (35, -90).
const GEOMETRY = Array.from({ length: 101 }, (_, i) => ({
  lat: 35 + i * 0.01449,
  lng: -90,
}));

describe("sliceGeometry", () => {
  it("returns the sub-polyline between two route miles", () => {
    const slice = sliceGeometry(GEOMETRY, 20, 30);
    expect(slice.length).toBeGreaterThan(5);
    expect(slice[0]!.lat).toBeCloseTo(35 + 20 * 0.01449, 2);
    expect(slice[slice.length - 1]!.lat).toBeCloseTo(35 + 30 * 0.01449, 2);
  });
  it("returns nothing for an empty or inverted slice", () => {
    expect(sliceGeometry(GEOMETRY, 30, 20)).toEqual([]);
    expect(sliceGeometry([], 0, 10)).toEqual([]);
  });
});

describe("sliceGeometryFromFraction", () => {
  it("returns the route from the fraction onward, starting interpolated", () => {
    const slice = sliceGeometryFromFraction(GEOMETRY, 0.5);
    expect(slice[0]!.lat).toBeCloseTo(35 + 50 * 0.01449, 2);
    expect(slice[slice.length - 1]!.lat).toBeCloseTo(35 + 100 * 0.01449, 2);
    expect(slice.length).toBeGreaterThan(40);
  });
  it("clamps out-of-range fractions", () => {
    expect(sliceGeometryFromFraction(GEOMETRY, 0)).toHaveLength(101);
    expect(sliceGeometryFromFraction(GEOMETRY, 1)).toHaveLength(1);
    expect(sliceGeometryFromFraction(GEOMETRY, 2)).toHaveLength(1);
  });
});

describe("segmentsToFeatureCollection", () => {
  it("one feature per colored stretch, carrying its color", () => {
    const fc = segmentsToFeatureCollection(GEOMETRY, [
      { fromMile: 20, toMile: 30, color: "#dc2626" },
      { fromMile: 60, toMile: 65, color: "#ea580c" },
    ]);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0]!.properties.color).toBe("#dc2626");
    expect(fc.features[0]!.geometry.type).toBe("LineString");
    expect(fc.features[0]!.geometry.coordinates[0]).toEqual([-90, expect.any(Number)]);
    expect(fc.features[1]!.properties.color).toBe("#ea580c");
  });
  it("skips a zero-length stretch", () => {
    const fc = segmentsToFeatureCollection(GEOMETRY, [{ fromMile: 50, toMile: 50, color: "#dc2626" }]);
    expect(fc.features).toHaveLength(0);
  });
});
