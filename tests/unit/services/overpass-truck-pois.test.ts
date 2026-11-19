import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  clearOverpassTruckPoisCache,
  fetchTruckPoiFeatures,
  OverpassTruckPoisError,
} from "@/services/integrations/overpass-truck-pois";

beforeEach(() => clearOverpassTruckPoisCache());

const line = (miles: number) =>
  Array.from({ length: miles + 1 }, (_, i) => ({ lat: 30 + i * 0.01449, lng: -82 }));

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

const overpassBody = {
  elements: [
    {
      type: "node",
      id: 201,
      lat: 30.5,
      lon: -82,
      tags: { amenity: "fuel", brand: "Love's", name: "Love's Travel Stop" },
    },
    {
      type: "way",
      id: 202,
      center: { lat: 30.7, lon: -82 },
      tags: { highway: "rest_area", name: "Greenville Rest Area" },
    },
    {
      type: "node",
      id: 203,
      lat: 30.9,
      lon: -82,
      tags: { amenity: "parking", hgv: "designated" },
    },
    {
      type: "node",
      id: 204,
      lat: 31.1,
      lon: -82,
      tags: { amenity: "fuel" },
    },
  ],
};

describe("fetchTruckPoiFeatures", () => {
  it("returns fuel, rest areas, and truck parking with names when the map records them", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(overpassBody));
    const features = await fetchTruckPoiFeatures({ fetchFn, points: line(50) });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(features).toHaveLength(4);
    expect(features[0]).toEqual({
      id: "node/201",
      point: { lat: 30.5, lng: -82 },
      kind: "fuel",
      name: "Love's Travel Stop",
    });
    expect(features[1]!.kind).toBe("rest");
    expect(features[1]!.name).toBe("Greenville Rest Area");
    expect(features[2]!.kind).toBe("parking");
    expect(features[3]!.name).toBeNull();
  });

  it("posts the Overpass query with the fuel / rest-area / truck-parking filters", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => jsonResponse(overpassBody));
    await fetchTruckPoiFeatures({ fetchFn, points: line(50) });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://overpass-api.de/api/interpreter");
    const body = decodeURIComponent(String(init!.body ?? ""));
    expect(body).toContain('"amenity"="fuel"');
    expect(body).toContain('"highway"="rest_area"');
    expect(body).toContain('"amenity"="parking"');
  });

  it("throws a named error when Overpass is down — the service turns that into 'unavailable'", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, false, 503));
    await expect(fetchTruckPoiFeatures({ fetchFn, points: line(50) })).rejects.toBeInstanceOf(
      OverpassTruckPoisError,
    );
  });

  it("returns nothing without corridor points", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(overpassBody));
    expect(await fetchTruckPoiFeatures({ fetchFn, points: [] })).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
