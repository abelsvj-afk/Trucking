// Smart Path truck-legal routing (docs/design/driver-mvp.md §8.5).
// Tested against fixtures matching the documented OpenRouteService
// and Valhalla shapes - NOT live-verified (this sandbox's network
// egress is blocked, the same restriction documented for EIA). The
// points under test: the truck's dimensions actually reach the
// request, the responses parse into the shared RouteResult, the
// shape decoder uses Valhalla's 1e6 precision, and the truckLegal
// flag follows the provider that actually served - never the one
// that was merely asked.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChainedRoutingProvider,
  defaultRoutingProvider,
  metricRestrictions,
  OsrmRoutingProvider,
  RoutingUnavailableError,
  type RouteResult,
  type RoutingProvider,
  type VehicleProfile,
} from "@/services/integrations/routing";
import { OpenRouteServiceRoutingProvider } from "@/services/integrations/openrouteservice";
import {
  decodeValhallaShape,
  ValhallaRoutingProvider,
} from "@/services/integrations/valhalla";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const FROM = { lat: 28.0836, lng: -80.6081 }; // Melbourne, FL
const TO = { lat: 33.749, lng: -84.388 }; // Atlanta, GA
// A 13'6" high, 53' long, 80,000 lb truck - Steven's-truck class.
const VEHICLE: VehicleProfile = { heightIn: 162, lengthIn: 636, weightLbs: 80_000 };

describe("metricRestrictions", () => {
  it("converts inches/pounds to meters/metric tons, rounded to 2dp", () => {
    expect(metricRestrictions(VEHICLE)).toEqual({
      heightMeters: 4.11, // 162 in = 4.1148 m
      lengthMeters: 16.15, // 636 in = 16.1544 m
      weightTons: 36.29, // 80,000 lb = 36.287 t
    });
  });

  it("omits dimensions that were never captured - never invents one", () => {
    expect(metricRestrictions({ heightIn: 162, lengthIn: null, weightLbs: null })).toEqual({
      heightMeters: 4.11,
    });
    expect(metricRestrictions({ heightIn: null, lengthIn: null, weightLbs: null })).toEqual({});
    expect(metricRestrictions(null)).toEqual({});
    expect(metricRestrictions(undefined)).toEqual({});
  });
});

describe("OpenRouteServiceRoutingProvider", () => {
  const okResponse = {
    type: "FeatureCollection",
    features: [
      {
        properties: { summary: { distance: 500_000, duration: 18_000 } },
        geometry: {
          type: "LineString",
          coordinates: [
            [-80.6081, 28.0836],
            [-84.388, 33.749],
          ],
        },
      },
    ],
  };

  it("sends the truck's dimensions as driving-hgv restrictions, with the key", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okResponse });
    global.fetch = fetchMock as never;

    await new OpenRouteServiceRoutingProvider("test-key").getRoute(FROM, TO, VEHICLE);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openrouteservice.org/v2/directions/driving-hgv/geojson");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("test-key");
    const body = JSON.parse(init.body as string) as {
      coordinates: number[][];
      options: { vehicle_type?: string; profile_params?: { restrictions: Record<string, number> } };
    };
    expect(body.coordinates).toEqual([
      [-80.6081, 28.0836],
      [-84.388, 33.749],
    ]);
    expect(body.options.vehicle_type).toBe("hgv");
    expect(body.options.profile_params?.restrictions).toEqual({
      length: 16.15,
      height: 4.11,
      weight: 36.29,
    });
  });

  it("omits profile_params entirely when no dimensions are captured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okResponse });
    global.fetch = fetchMock as never;

    await new OpenRouteServiceRoutingProvider("test-key").getRoute(FROM, TO, null);

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as {
      options: Record<string, unknown>;
    };
    expect(body.options).toEqual({ vehicle_type: "hgv" });
  });

  it("parses the GeoJSON route and claims truckLegal", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => okResponse }) as never;
    const route = await new OpenRouteServiceRoutingProvider("test-key").getRoute(FROM, TO, VEHICLE);
    expect(route.distanceMiles).toBeCloseTo(310.69, 1);
    expect(route.durationMinutes).toBe(300);
    expect(route.geometry).toEqual([FROM, TO]);
    expect(route.truckLegal).toBe(true);
    expect(route.providerName).toContain("OpenRouteService");
  });

  it("fails loudly on a rejected key and on an unexpected shape", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as never;
    await expect(new OpenRouteServiceRoutingProvider("bad-key").getRoute(FROM, TO, VEHICLE)).rejects.toThrow(
      /rejected the API key/,
    );

    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ features: [] }) }) as never;
    await expect(new OpenRouteServiceRoutingProvider("test-key").getRoute(FROM, TO, VEHICLE)).rejects.toBeInstanceOf(
      RoutingUnavailableError,
    );
  });
});

describe("decodeValhallaShape", () => {
  it("decodes at 1e6 precision (Valhalla), not 1e5 (Google)", () => {
    expect(decodeValhallaShape("??")).toEqual([{ lat: 0, lng: 0 }]);
    const [origin, nudged] = decodeValhallaShape("??A?") as [never, never] as [
      { lat: number; lng: number },
      { lat: number; lng: number },
    ];
    expect(origin).toEqual({ lat: 0, lng: 0 });
    // A one-microdegree latitude step: at 1e5 precision this would
    // wrongly read 0.00001 - the assertion pins the precision.
    expect(nudged.lat).toBeCloseTo(0.000001, 9);
    expect(nudged.lng).toBe(0);
  });

  it("decodes negative deltas", () => {
    const [, south] = decodeValhallaShape("??@?") as [{ lat: number; lng: number }, { lat: number; lng: number }];
    expect(south.lat).toBeCloseTo(-0.000001, 9);
  });
});

describe("ValhallaRoutingProvider", () => {
  const okResponse = {
    trip: {
      status: 0,
      summary: { length: 310.7, time: 18_000 },
      legs: [{ shape: "??" }],
    },
  };

  it("sends truck costing with the truck's dimensions, in miles", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okResponse });
    global.fetch = fetchMock as never;

    await new ValhallaRoutingProvider().getRoute(FROM, TO, VEHICLE);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://valhalla1.openstreetmap.de/route");
    const body = JSON.parse(init.body as string) as {
      locations: { lat: number; lon: number }[];
      costing: string;
      costing_options?: { truck: Record<string, number> };
      directions_options: { units: string };
    };
    expect(body.locations).toEqual([
      { lat: FROM.lat, lon: FROM.lng },
      { lat: TO.lat, lon: TO.lng },
    ]);
    expect(body.costing).toBe("truck");
    expect(body.costing_options?.truck).toEqual({ height: 4.11, length: 16.15, weight: 36.29 });
    expect(body.directions_options.units).toBe("miles");
  });

  it("omits costing_options when no dimensions are captured", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okResponse });
    global.fetch = fetchMock as never;

    await new ValhallaRoutingProvider().getRoute(FROM, TO, null);

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.costing).toBe("truck");
    expect(body.costing_options).toBeUndefined();
  });

  it("parses summary + decoded shape and claims truckLegal", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => okResponse }) as never;
    const route = await new ValhallaRoutingProvider().getRoute(FROM, TO, VEHICLE);
    expect(route.distanceMiles).toBe(310.7);
    expect(route.durationMinutes).toBe(300);
    expect(route.geometry).toEqual([{ lat: 0, lng: 0 }]);
    expect(route.truckLegal).toBe(true);
  });

  it("does not duplicate the joint point between legs", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ trip: { status: 0, summary: { length: 1, time: 60 }, legs: [{ shape: "??" }, { shape: "??" }] } }),
    }) as never;
    const route = await new ValhallaRoutingProvider().getRoute(FROM, TO, VEHICLE);
    expect(route.geometry).toEqual([{ lat: 0, lng: 0 }]);
  });

  it("fails loudly on HTTP errors, bad shapes, and non-zero trip status", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as never;
    await expect(new ValhallaRoutingProvider().getRoute(FROM, TO, VEHICLE)).rejects.toBeInstanceOf(
      RoutingUnavailableError,
    );

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      // "?" ends mid-value - the decoder must refuse, not guess.
      json: async () => ({ trip: { status: 0, summary: { length: 1, time: 60 }, legs: [{ shape: "?" }] } }),
    }) as never;
    await expect(new ValhallaRoutingProvider().getRoute(FROM, TO, VEHICLE)).rejects.toBeInstanceOf(
      RoutingUnavailableError,
    );

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ trip: { status: 1, summary: { length: 1, time: 60 }, legs: [{ shape: "??" }] } }),
    }) as never;
    await expect(new ValhallaRoutingProvider().getRoute(FROM, TO, VEHICLE)).rejects.toThrow(/trip status 1/);
  });
});

function stubProvider(name: string, result: Partial<RouteResult> | Error): RoutingProvider & { calls: number } {
  const provider = {
    name,
    calls: 0,
    async getRoute(): Promise<RouteResult> {
      provider.calls += 1;
      if (result instanceof Error) throw result;
      return {
        distanceMiles: 100,
        durationMinutes: 120,
        geometry: [FROM, TO],
        providerName: name,
        truckLegal: false,
        providerNotes: [],
        ...result,
      };
    },
  };
  return provider;
}

describe("ChainedRoutingProvider - the truckLegal truth table", () => {
  it("truck provider serves -> truckLegal true, fallback never asked, skip notes carried", async () => {
    const truck = stubProvider("TruckStub", { truckLegal: true });
    const car = stubProvider("CarStub", { truckLegal: false });
    const chain = new ChainedRoutingProvider([truck, car], ["a skip note"]);

    const route = await chain.getRoute(FROM, TO, VEHICLE);
    expect(route.truckLegal).toBe(true);
    expect(route.providerName).toBe("TruckStub");
    expect(car.calls).toBe(0);
    expect(route.providerNotes).toEqual(["a skip note"]);
  });

  it("truck provider down -> car serves -> truckLegal FALSE, and the fallback is noted", async () => {
    const truck = stubProvider("TruckStub", new RoutingUnavailableError("unreachable"));
    const car = stubProvider("CarStub", { truckLegal: false });
    const chain = new ChainedRoutingProvider([truck, car]);

    const route = await chain.getRoute(FROM, TO, VEHICLE);
    expect(route.truckLegal).toBe(false);
    expect(route.providerName).toBe("CarStub");
    expect(route.providerNotes).toHaveLength(1);
    expect(route.providerNotes[0]).toContain("TruckStub");
    expect(route.providerNotes[0]).toContain("fell back");
  });

  it("every provider down -> the chain fails with all reasons, fabricating nothing", async () => {
    const chain = new ChainedRoutingProvider([
      stubProvider("TruckStub", new RoutingUnavailableError("unreachable")),
      stubProvider("CarStub", new RoutingUnavailableError("HTTP 503")),
    ]);
    await expect(chain.getRoute(FROM, TO, VEHICLE)).rejects.toBeInstanceOf(RoutingUnavailableError);
    await expect(chain.getRoute(FROM, TO, VEHICLE)).rejects.toThrow(/TruckStub/);
  });

  it("non-routing errors propagate instead of degrading", async () => {
    const chain = new ChainedRoutingProvider([stubProvider("BuggyStub", new TypeError("bug"))]);
    await expect(chain.getRoute(FROM, TO, VEHICLE)).rejects.toBeInstanceOf(TypeError);
  });
});

describe("defaultRoutingProvider (env-built chain)", () => {
  it("without ORS_API_KEY: ORS is skipped WITH a note; Valhalla then OSRM remain", () => {
    const chain = defaultRoutingProvider({});
    expect(chain.providers.map((p) => p.name)).toEqual([
      "Valhalla (truck costing, public OpenStreetMap endpoint)",
      "OSRM (public demo, car profile)",
    ]);
    expect(chain.skipNotes).toHaveLength(1);
    expect(chain.skipNotes[0]).toContain("ORS_API_KEY is not set");
  });

  it("with ORS_API_KEY: ORS leads the chain and nothing is skipped", () => {
    const chain = defaultRoutingProvider({ ORS_API_KEY: "some-key" });
    expect(chain.providers.map((p) => p.name)).toEqual([
      "OpenRouteService (driving-hgv truck profile)",
      "Valhalla (truck costing, public OpenStreetMap endpoint)",
      "OSRM (public demo, car profile)",
    ]);
    expect(chain.skipNotes).toEqual([]);
  });

  it("OSRM alone still reports truckLegal false (the v1 claim, unchanged)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: "Ok",
        routes: [{ distance: 1000, duration: 600, geometry: { coordinates: [[FROM.lng, FROM.lat], [TO.lng, TO.lat]] } }],
      }),
    }) as never;
    const route = await new OsrmRoutingProvider().getRoute(FROM, TO, VEHICLE);
    expect(route.truckLegal).toBe(false);
  });
});
