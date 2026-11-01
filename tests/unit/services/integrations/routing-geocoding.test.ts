// Smart Path v1 providers (docs/design/driver-mvp.md §8.1). Tested
// against fixtures matching the documented OSRM / Nominatim shapes -
// NOT live-verified (this sandbox's network egress is blocked, the
// same restriction documented for EIA in eia.test.ts). The strict Zod
// validation in each provider is the point: a shape change must fail
// loudly, never produce a plausible-looking wrong route.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OsrmRoutingProvider,
  RoutingUnavailableError,
} from "@/services/integrations/routing";
import { NominatimGeocodingProvider } from "@/services/integrations/geocoding";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("OsrmRoutingProvider", () => {
  it("parses a route into miles, minutes, and LatLng geometry", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: "Ok",
        routes: [
          {
            distance: 500_000,
            duration: 18_000,
            geometry: {
              coordinates: [
                [-80.6081, 28.0836],
                [-84.388, 33.749],
              ],
            },
          },
        ],
      }),
    }) as never;

    const route = await new OsrmRoutingProvider().getRoute(
      { lat: 28.0836, lng: -80.6081 },
      { lat: 33.749, lng: -84.388 },
    );
    expect(route.distanceMiles).toBeCloseTo(310.69, 1);
    expect(route.durationMinutes).toBe(300);
    expect(route.geometry).toEqual([
      { lat: 28.0836, lng: -80.6081 },
      { lat: 33.749, lng: -84.388 },
    ]);
  });

  it("fails loudly (never fabricates) when the provider is unreachable", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as never;
    await expect(
      new OsrmRoutingProvider().getRoute({ lat: 1, lng: 1 }, { lat: 2, lng: 2 }),
    ).rejects.toBeInstanceOf(RoutingUnavailableError);
  });

  it("fails loudly on an unexpected response shape", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: "Ok", routes: [] }),
    }) as never;
    await expect(
      new OsrmRoutingProvider().getRoute({ lat: 1, lng: 1 }, { lat: 2, lng: 2 }),
    ).rejects.toBeInstanceOf(RoutingUnavailableError);
  });
});

describe("NominatimGeocodingProvider", () => {
  it("parses the first result into a LatLng", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ lat: "28.0836", lon: "-80.6081" }],
    }) as never;
    const point = await new NominatimGeocodingProvider().geocode("Melbourne, FL (test fixture)");
    expect(point).toEqual({ lat: 28.0836, lng: -80.6081 });
  });

  it("returns null (a stated miss) when nothing matches", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    }) as never;
    const point = await new NominatimGeocodingProvider().geocode("Nowheresville, ZZ (test fixture)");
    expect(point).toBeNull();
  });
});
