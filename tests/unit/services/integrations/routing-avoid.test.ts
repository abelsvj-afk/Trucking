// Smart Path live awareness (owner 2026-11-17): avoid circles
// reach the truck engines as polygons, and the car profile refuses
// them outright — a car detour must never be offered as a truck
// detour. Tested against fixtures matching the documented ORS /
// Valhalla shapes, NOT live-verified.

import { afterEach, describe, expect, it, vi } from "vitest";
import { OsrmRoutingProvider, RoutingUnavailableError } from "@/services/integrations/routing";
import { OpenRouteServiceRoutingProvider } from "@/services/integrations/openrouteservice";
import { ValhallaRoutingProvider } from "@/services/integrations/valhalla";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const FROM = { lat: 28.0836, lng: -80.6081 };
const TO = { lat: 33.749, lng: -84.388 };
const AVOID = [{ lat: 30.9, lng: -82.5, radiusMiles: 5 }];

describe("OpenRouteServiceRoutingProvider with avoid", () => {
  it("sends avoid circles as an avoid_polygons MultiPolygon", async () => {
    const okResponse = {
      type: "FeatureCollection",
      features: [
        {
          properties: { summary: { distance: 500_000, duration: 18_000 } },
          geometry: { type: "LineString", coordinates: [[-80.6081, 28.0836], [-84.388, 33.749]] },
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okResponse });
    global.fetch = fetchMock as never;

    const route = await new OpenRouteServiceRoutingProvider("test-key").getRoute(FROM, TO, null, {
      avoidCircles: AVOID,
    });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as {
      options: { avoid_polygons?: { type: string; coordinates: unknown[][][] } };
    };
    expect(body.options.avoid_polygons?.type).toBe("MultiPolygon");
    expect(body.options.avoid_polygons?.coordinates).toHaveLength(1);
    expect(body.options.avoid_polygons?.coordinates[0]![0]).toHaveLength(17);
    expect(route.truckLegal).toBe(true);
  });

  it("sends no avoid_polygons when no circles are given", async () => {
    const okResponse = {
      type: "FeatureCollection",
      features: [
        {
          properties: { summary: { distance: 500_000, duration: 18_000 } },
          geometry: { type: "LineString", coordinates: [[-80.6081, 28.0836], [-84.388, 33.749]] },
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okResponse });
    global.fetch = fetchMock as never;

    await new OpenRouteServiceRoutingProvider("test-key").getRoute(FROM, TO, null);

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as {
      options: Record<string, unknown>;
    };
    expect(body.options.avoid_polygons).toBeUndefined();
  });
});

describe("ValhallaRoutingProvider with avoid", () => {
  it("sends avoid circles as exclude_polygons", async () => {
    const okResponse = {
      trip: {
        status: 0,
        summary: { length: 310, time: 18000 },
        legs: [{ shape: "??", maneuvers: [] }],
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okResponse });
    global.fetch = fetchMock as never;

    await new ValhallaRoutingProvider().getRoute(FROM, TO, null, { avoidCircles: AVOID });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as {
      exclude_polygons?: { lat: number; lon: number }[][][];
    };
    expect(body.exclude_polygons).toHaveLength(1);
    expect(body.exclude_polygons![0]![0]).toHaveLength(17);
    expect(body.exclude_polygons![0]![0]![0]).toEqual({ lat: expect.any(Number), lon: expect.any(Number) });
  });
});

describe("OsrmRoutingProvider with avoid", () => {
  it("refuses an avoid request before fetching — no car detour, ever", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as never;
    await expect(
      new OsrmRoutingProvider().getRoute(FROM, TO, null, { avoidCircles: AVOID }),
    ).rejects.toBeInstanceOf(RoutingUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
