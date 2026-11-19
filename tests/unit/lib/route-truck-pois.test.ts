import { describe, expect, it } from "vitest";
import { truckPoiItems } from "@/services/smart-path/route-truck-pois";
import type { TruckPoiFeature } from "@/services/integrations/overpass-truck-pois";

// A straight northbound line: ~1 mile per 0.01449 degrees of latitude.
const line = (miles: number) =>
  Array.from({ length: miles + 1 }, (_, i) => ({ lat: 30 + i * 0.01449, lng: -82 }));

const feature = (id: string, lat: number, kind: TruckPoiFeature["kind"], name: string | null = null): TruckPoiFeature => ({
  id,
  point: { lat, lng: -82 },
  kind,
  name,
});

describe("truckPoiItems", () => {
  const geometry = line(20);

  it("maps stops onto the route in miles, nearest first", () => {
    const items = truckPoiItems(
      [
        feature("node/2", 30 + 9 * 0.01449, "fuel", "Love's"),
        feature("node/1", 30 + 3 * 0.01449, "rest"),
        feature("node/3", 30 + 17 * 0.01449, "parking"),
      ],
      geometry,
    );
    expect(items.map((i) => i.id)).toEqual(["node/1", "node/2", "node/3"]);
    expect(items[0]!.mile).toBeCloseTo(3, 1);
    expect(items[1]!.mile).toBeCloseTo(9, 1);
    expect(items[1]!.kind).toBe("fuel");
    expect(items[1]!.name).toBe("Love's");
  });

  it("drops a stop the projection cannot put on the line — a detour is not his stop", () => {
    const items = truckPoiItems(
      [feature("node/9", 31.5, "fuel", "Far Away Fuel")],
      geometry,
    );
    expect(items).toEqual([]);
  });

  it("returns nothing without geometry", () => {
    expect(truckPoiItems([feature("node/1", 30.1, "fuel")], [])).toEqual([]);
  });
});
