import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  clearOverpassBridgesCache,
  fetchBridgeFeatures,
  OverpassBridgesError,
} from "@/services/integrations/overpass-bridges";

beforeEach(() => clearOverpassBridgesCache());

const line = (miles: number) =>
  Array.from({ length: miles + 1 }, (_, i) => ({ lat: 35 + i * 0.01449, lng: -90 }));

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

const overpassBody = {
  elements: [
    {
      type: "way",
      id: 101,
      center: { lat: 35.6, lon: -90 },
      tags: { bridge: "yes", maxheight: "13'6\"", ref: "I-55", name: "River Bridge" },
    },
    {
      type: "way",
      id: 102,
      center: { lat: 36.0, lon: -90 },
      tags: { bridge: "yes", maxheight: "4.2" },
    },
    {
      type: "way",
      id: 103,
      center: { lat: 36.2, lon: -90 },
      tags: { bridge: "yes" },
    },
  ],
};

describe("fetchBridgeFeatures", () => {
  it("returns bridges with a recorded clearance, parsed to inches", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(overpassBody));
    const features = await fetchBridgeFeatures({ fetchFn, points: line(50) });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(features).toHaveLength(2);
    expect(features[0]).toEqual({
      id: "way/101",
      point: { lat: 35.6, lng: -90 },
      maxHeightIn: 162,
      name: "River Bridge",
      road: "I-55",
    });
    expect(features[1]!.maxHeightIn).toBeCloseTo(165.4, 0);
  });
  it("drops a bridge with no recorded clearance — never presented as cleared", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(overpassBody));
    const features = await fetchBridgeFeatures({ fetchFn, points: line(50) });
    expect(features.map((f) => f.id)).not.toContain("way/103");
  });
  it("posts the Overpass query with the bridge+maxheight filter and a bbox", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => jsonResponse({ elements: [] }));
    await fetchBridgeFeatures({ fetchFn, points: line(20) });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://overpass-api.de/api/interpreter");
    const body = String(init!.body);
    expect(decodeURIComponent(body)).toContain('way["bridge"]["maxheight"]');
    expect(decodeURIComponent(body)).toContain("out tags center");
  });
  it("serves the second identical call from cache", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(overpassBody));
    const first = await fetchBridgeFeatures({ fetchFn, points: line(50) });
    const second = await fetchBridgeFeatures({ fetchFn, points: line(50) });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });
  it("throws an OverpassBridgesError on HTTP failure", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, false, 429));
    await expect(fetchBridgeFeatures({ fetchFn, points: line(20) })).rejects.toBeInstanceOf(
      OverpassBridgesError,
    );
  });
  it("returns nothing for no points", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(overpassBody));
    expect(await fetchBridgeFeatures({ fetchFn, points: [] })).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
