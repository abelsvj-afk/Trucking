// Smart Path Piece 1 service layer: the route check over a fake
// Supabase + stub providers (the harness mirrors
// tests/unit/services/bot/route-check-tool.test.ts).
// - P1-7: a start produces a populated deadhead block; an
//   unresolvable start is a 400 GEOCODE_MISS naming the start.
// - P1-6: the fuel-price estimate seam lands on map candidates;
//   a null estimate reproduces today's candidate shape exactly.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "@/services/api/errors";
import { routeCheckRequestSchema } from "@/data/schemas/smart-path";
import {
  runRouteCheck,
  type RouteCheckProviders,
} from "@/services/smart-path/route-check";
import type { Place } from "@/services/integrations/places";

const LOAD_ID = "16161616-1616-4616-8616-161616161616";
const NOW = new Date("2026-11-01T12:00:00Z");

const MELBOURNE = { lat: 28.08, lng: -80.6 };
const ATLANTA = { lat: 33.75, lng: -84.39 };
const ORLANDO = { lat: 28.54, lng: -81.38 };

// --- fake Supabase (mirrors the bot route-check-tool harness) --------

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: { col: string; val: unknown }[] = [];
  constructor(private rows: Row[]) {}
  select() {
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ col, val });
    return this;
  }
  is() {
    return this;
  }
  gte() {
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  private matched(): Row[] {
    return this.rows.filter((row) => this.filters.every((f) => row[f.col] === f.val));
  }
  async maybeSingle() {
    return { data: this.matched()[0] ?? null, error: null };
  }
  then(resolve: (v: { data: Row[]; error: null }) => void) {
    resolve({ data: this.matched(), error: null });
  }
}

function fakeClient() {
  const tables: Record<string, Row[]> = {
    loads: [
      {
        id: LOAD_ID,
        origin: "Melbourne, FL",
        destination: "Atlanta, GA",
        status: "confirmed",
        truck_id: null,
        rate_cents: 200000,
        miles: 500,
        deleted_at: null,
      },
    ],
    trucks: [],
    duty_logs: [],
    fuel_purchases: [],
  };
  return {
    from: (table: string) => new FakeQuery(tables[table] ?? []),
  } as unknown as SupabaseClient;
}

// --- stub providers ----------------------------------------------------

function makeProviders(
  overrides: {
    places?: Place[];
    estimate?: { cents: number; label: string } | null;
  } = {},
): RouteCheckProviders {
  return {
    geocoding: {
      geocode: async (place: string) => {
        if (place.includes("Atlantis")) return null;
        if (place.includes("Orlando")) return { ...ORLANDO };
        if (place.includes("Melbourne")) return { ...MELBOURNE };
        if (place.includes("Atlanta")) return { ...ATLANTA };
        return { lat: 30, lng: -82 };
      },
    },
    routing: {
      getRoute: async (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => {
        const isDeadhead = to.lat === MELBOURNE.lat && to.lng === MELBOURNE.lng;
        return {
          distanceMiles: isDeadhead ? 105.2 : 400,
          durationMinutes: isDeadhead ? 110 : 400,
          geometry: [from, to],
          providerName: "Valhalla (truck costing)",
          truckLegal: true,
          providerNotes: [],
        };
      },
    },
    places: { findNear: async () => overrides.places ?? [] },
    fuelPriceEstimate: async () => overrides.estimate ?? null,
  } as unknown as RouteCheckProviders;
}

function parseRequest(extra: Record<string, unknown>) {
  return routeCheckRequestSchema.parse({
    load_id: LOAD_ID,
    depart_at: "2026-11-02T12:00:00.000Z",
    ...extra,
  });
}

describe("runRouteCheck - Piece 1 deadhead (P1-7)", () => {
  it("populates the deadhead block, geometry included, when a start is given", async () => {
    const response = await runRouteCheck(
      fakeClient(),
      parseRequest({
        start_location: "Orlando, FL",
        delivery_window: { start: "2026-11-03T00:00:00Z", end: "2026-11-03T12:00:00Z" },
      }),
      makeProviders(),
      NOW,
    );
    expect(response.deadhead).not.toBeNull();
    expect(response.deadhead!.startLabel).toBe("Orlando, FL");
    expect(response.deadhead!.startPoint).toEqual(ORLANDO);
    expect(response.deadhead!.distanceMiles).toBe(105.2);
    expect(response.deadhead!.providerDurationMinutes).toBe(110);
    expect(response.deadhead!.provider).toBe("Valhalla (truck costing)");
    expect(response.deadhead!.truckLegal).toBe(true);
    expect(response.deadhead!.geometry).toEqual([ORLANDO, MELBOURNE]);
    // The lib's preLeg result rides the block: leave-by, pickup
    // arrival and any wait at the pickup are real strings/numbers.
    expect(typeof response.deadhead!.leaveByAt).toBe("string");
    expect(Number.isFinite(Date.parse(response.deadhead!.leaveByAt))).toBe(true);
    expect(typeof response.deadhead!.pickupArrivalAt).toBe("string");
    expect(Number.isFinite(Date.parse(response.deadhead!.pickupArrivalAt))).toBe(true);
    expect(typeof response.deadhead!.waitMinutesAtPickup).toBe("number");
    expect(response.verdict.leaveStartByAt).not.toBeNull();
  });

  it("rejects an unresolvable start_location with a 400 GEOCODE_MISS naming the start", async () => {
    const err = await runRouteCheck(
      fakeClient(),
      parseRequest({ start_location: "Atlantis, XX" }),
      makeProviders(),
      NOW,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).code).toBe("GEOCODE_MISS");
    expect((err as ApiError).message).toContain("Atlantis, XX");
  });

  it("carries no deadhead block when no start is given (today's shape)", async () => {
    const response = await runRouteCheck(fakeClient(), parseRequest({}), makeProviders(), NOW);
    expect(response.deadhead).toBeNull();
    expect(response.verdict.leaveStartByAt).toBeNull();
  });

  it("returns a corridor with a time at every point along the loaded route (intelligence Phase 1)", async () => {
    const response = await runRouteCheck(fakeClient(), parseRequest({}), makeProviders(), NOW);
    const corridor = response.corridor;
    expect(corridor && "points" in corridor).toBe(true);
    if (!corridor || !("points" in corridor)) return;
    expect(corridor.points[0]!.mile).toBe(0);
    expect(corridor.points[corridor.points.length - 1]!.mile).toBeCloseTo(corridor.totalMiles, 0);
    const times = corridor.points.map((p) => p.etaAt && Date.parse(p.etaAt));
    expect(times.every((t) => typeof t === "number")).toBe(true);
    expect([...times].sort()).toEqual(times);
  });
});

describe("runRouteCheck - weather section (intelligence Phase 2b)", () => {
  it("adds a weather section from the injected fetchers, advisory only (verdict unchanged)", async () => {
    const base = await runRouteCheck(fakeClient(), parseRequest({}), makeProviders(), NOW);
    expect(base.weather).toBeUndefined();
    const providers = makeProviders();
    providers.weather = { hourly: async () => { throw new Error("NWS down"); }, alerts: async () => [] };
    const response = await runRouteCheck(fakeClient(), parseRequest({}), providers, NOW);
    expect(response.weather?.status).toBe("unavailable");
    expect(response.verdict.status).toBe(base.verdict.status);
  });
});

describe("runRouteCheck - reroute from the current position (audit D4)", () => {
  const HERE = { lat: 31.2, lng: -83.1 };

  it("with already_picked_up the run starts HERE and goes straight to the destination: no pickup leg, no deadhead", async () => {
    const legs: { from: unknown; to: unknown }[] = [];
    const providers = makeProviders();
    const original = providers.routing.getRoute;
    providers.routing.getRoute = (async (from: { lat: number; lng: number }, to: { lat: number; lng: number }, ...rest: unknown[]) => {
      legs.push({ from, to });
      return (original as (...a: unknown[]) => unknown)(from, to, ...rest);
    }) as never;
    const response = await runRouteCheck(fakeClient(), parseRequest({ start_point: HERE, already_picked_up: true }), providers, NOW);
    expect(response.deadhead).toBeNull();
    expect(response.route.originPoint).toEqual(HERE);
    expect(response.route.destinationPoint).toEqual(ATLANTA);
    expect(legs).toEqual([{ from: HERE, to: ATLANTA }]); // exactly one leg; Melbourne (the pickup) never routed
    expect(response.warnings.join(" ")).toContain("pickup is already behind you");
  });

  it("does not even look up the pickup: an unresolvable pickup address can't block a reroute", async () => {
    const providers = makeProviders();
    const geocoded: string[] = [];
    const inner = providers.geocoding.geocode;
    providers.geocoding.geocode = async (place: string) => {
      geocoded.push(place);
      return inner(place);
    };
    await runRouteCheck(fakeClient(), parseRequest({ start_point: HERE, already_picked_up: true }), providers, NOW);
    expect(geocoded).toEqual(["Atlanta, GA"]);
  });

  it("without a start_point the flag is ignored: the normal pickup-first behaviour is unchanged", async () => {
    const response = await runRouteCheck(fakeClient(), parseRequest({ already_picked_up: true }), makeProviders(), NOW);
    expect(response.route.originPoint).toEqual(MELBOURNE);
  });

  it("the ordinary deadhead behaviour is untouched when the flag is absent", async () => {
    const response = await runRouteCheck(fakeClient(), parseRequest({ start_point: HERE }), makeProviders(), NOW);
    expect(response.deadhead).not.toBeNull();
    expect(response.route.originPoint).toEqual(MELBOURNE);
  });
});

describe("runRouteCheck - Piece 1 fuel estimate (P1-6)", () => {
  const FUEL_PLACE: Place = {
    id: "node/1",
    name: "Truck Stop",
    kind: "fuel",
    lat: 30,
    lng: -82,
  };

  it("attaches the estimate to map candidates and ranks with it", async () => {
    const estimate = { cents: 392, label: "EIA U.S. average, week of Oct 26" };
    const response = await runRouteCheck(
      fakeClient(),
      parseRequest({}),
      makeProviders({ places: [FUEL_PLACE], estimate }),
      NOW,
    );
    const candidate = response.fuel.candidates.find((c) => c.source === "map");
    expect(candidate).toBeDefined();
    expect(candidate!.estimatedPricePerGallonCents).toBe(392);
    expect(candidate!.estimateLabel).toBe("EIA U.S. average, week of Oct 26");
    expect(candidate!.usedEstimate).toBe(true);
    // The estimate never becomes a claimed real price.
    expect(candidate!.pricePerGallonCents).toBeNull();
  });

  it("leaves candidates in today's shape when the estimate is unavailable", async () => {
    const response = await runRouteCheck(
      fakeClient(),
      parseRequest({}),
      makeProviders({ places: [FUEL_PLACE], estimate: null }),
      NOW,
    );
    const candidate = response.fuel.candidates.find((c) => c.source === "map");
    expect(candidate).toBeDefined();
    expect(candidate!.estimatedPricePerGallonCents).toBeNull();
    expect(candidate!.estimateLabel).toBeNull();
    expect(candidate!.usedEstimate).toBe(false);
  });

  it("survives a throwing estimate provider - the check still answers", async () => {
    const providers = makeProviders({ places: [FUEL_PLACE] });
    providers.fuelPriceEstimate = vi.fn(async () => {
      throw new Error("estimate seam exploded");
    }) as RouteCheckProviders["fuelPriceEstimate"];
    const response = await runRouteCheck(fakeClient(), parseRequest({}), providers, NOW);
    const candidate = response.fuel.candidates.find((c) => c.source === "map");
    expect(candidate!.estimatedPricePerGallonCents).toBeNull();
    expect(candidate!.usedEstimate).toBe(false);
  });
});

describe("runRouteCheck - Drive Mode D1 additive fields", () => {
  it("passes provider maneuvers through on route and deadhead, and carries the clocks", async () => {
    const providers = makeProviders();
    const maneuvers = [
      { instruction: "Head north on I-95.", distanceMiles: 90, atFraction: 0 },
      { instruction: "Turn right at the gate.", distanceMiles: 10, atFraction: 0.9 },
    ];
    (providers as { routing: { getRoute: unknown } }).routing = {
      getRoute: async (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => {
        const isDeadhead = to.lat === MELBOURNE.lat && to.lng === MELBOURNE.lng;
        return {
          distanceMiles: isDeadhead ? 105.2 : 400,
          durationMinutes: isDeadhead ? 110 : 400,
          geometry: [from, to],
          providerName: "Valhalla (truck costing)",
          truckLegal: true,
          providerNotes: [],
          maneuvers,
        };
      },
    };
    const response = await runRouteCheck(
      fakeClient(),
      parseRequest({ start_location: "Orlando, FL" }),
      providers,
      NOW,
    );
    expect(response.route.maneuvers).toEqual(maneuvers);
    expect(response.deadhead?.maneuvers).toEqual(maneuvers);
    // No duty logs in the fake client: fresh clocks, honestly flagged.
    expect(response.clocks).toBeDefined();
    expect(response.clocks!.fromLogs).toBe(false);
    expect(response.clocks!.driveLeftMin).toBeGreaterThan(0);
  });

  it("omits maneuvers when the provider returns none (no fabrication)", async () => {
    const response = await runRouteCheck(fakeClient(), parseRequest({}), makeProviders(), NOW);
    expect(response.route.maneuvers).toBeUndefined();
    expect(response.clocks).toBeDefined();
  });
});

describe("runRouteCheck - live awareness (owner 2026-11-17)", () => {
  // Midpoint of the stub loaded leg (Melbourne -> Atlanta), on the line.
  const MID = { lat: 30.915, lng: -82.495 };

  // Real routing providers return dense geometry; the shared stub
  // returns two endpoints, which the vertex-approximation mapping
  // cannot judge — so this lane's providers interpolate the line.
  function denseProviders() {
    const providers = makeProviders();
    const original = providers.routing.getRoute;
    providers.routing.getRoute = (async (
      from: { lat: number; lng: number },
      to: { lat: number; lng: number },
      ...rest: unknown[]
    ) => {
      const result = (await (original as unknown as (...a: unknown[]) => Promise<Record<string, unknown>>)(from, to, ...rest)) as Record<string, unknown>;
      const points = [];
      const n = 40;
      for (let i = 0; i <= n; i++) {
        points.push({
          lat: from.lat + ((to.lat - from.lat) * i) / n,
          lng: from.lng + ((to.lng - from.lng) * i) / n,
        });
      }
      return { ...result, geometry: points };
    }) as never;
    return providers;
  }

  it("adds traffic + bridges sections from the injected seams, advisory only (verdict unchanged)", async () => {
    const base = await runRouteCheck(fakeClient(), parseRequest({}), makeProviders(), NOW);
    expect(base.traffic).toBeUndefined();
    expect(base.bridges).toBeUndefined();

    const providers = denseProviders();
    providers.traffic = {
      incidents: async () => [
        {
          id: "inc-1",
          iconCategory: 6,
          description: "Queue",
          points: [MID],
          delaySeconds: 1800,
          magnitude: 3,
          startTime: null,
          endTime: "2026-11-02T18:00:00.000Z",
          from: "A",
          to: "B",
          lengthMeters: 4000,
          roadNumbers: ["I-75"],
        },
      ],
    };
    providers.bridges = {
      features: async () => [
        { id: "way/1", point: MID, maxHeightIn: 160, name: null, road: "I-75" },
      ],
    };
    const response = await runRouteCheck(fakeClient(), parseRequest({}), providers, NOW);
    expect(response.verdict.status).toBe(base.verdict.status);

    expect(response.traffic?.status).toBe("ok");
    expect(response.traffic?.items).toHaveLength(1);
    expect(response.traffic?.items[0]!.severity).toBe("severe");
    expect(response.traffic?.segments).toHaveLength(1);
    expect(response.traffic?.segments[0]!.color).toBe("#dc2626");
    // The stub detour is truck-checked at the 400-min provider
    // duration; the plan assumes 436 min (400 miles at 55 mph), so
    // staying costs the 30-min delay and the detour wins by 66.
    expect(response.traffic?.call.decision).toBe("reroute");
    expect(response.traffic?.call.savesMinutes).toBe(66);

    expect(response.bridges?.status).toBe("ok");
    expect(response.bridges?.items).toHaveLength(1);
    // No truck row in the fake client: height unknown, never a pass.
    expect(response.bridges?.items[0]!.clearance).toBe("unknown");
  });

  it("passes an avoid request to the loaded-leg routing call", async () => {
    const providers = makeProviders();
    const calls: unknown[][] = [];
    const original = providers.routing.getRoute;
    providers.routing.getRoute = (async (...args: unknown[]) => {
      calls.push(args);
      return (original as (...a: unknown[]) => unknown)(...args);
    }) as never;
    await runRouteCheck(
      fakeClient(),
      parseRequest({ avoid: [{ lat: 30.9, lng: -82.5, radiusMiles: 5 }] }),
      providers,
      NOW,
    );
    const loaded = calls.find(
      (c) => (c[1] as { lat: number; lng: number }).lat === ATLANTA.lat,
    );
    expect(loaded).toBeDefined();
    expect(loaded![3]).toEqual({ avoidCircles: [{ lat: 30.9, lng: -82.5, radiusMiles: 5 }] });
  });

  it("keeps the no-detour call when routing cannot serve a detour", async () => {
    const providers = denseProviders();
    providers.traffic = {
      incidents: async () => [
        {
          id: "inc-1",
          iconCategory: 6,
          description: "Queue",
          points: [MID],
          delaySeconds: 1800,
          magnitude: 3,
          startTime: null,
          endTime: "2026-11-02T18:00:00.000Z",
          from: "A",
          to: "B",
          lengthMeters: 4000,
          roadNumbers: ["I-75"],
        },
      ],
    };
    // Routing answers the plan but refuses every avoid request.
    const original = providers.routing.getRoute;
    providers.routing.getRoute = (async (...args: unknown[]) => {
      const options = args[3] as { avoidCircles?: unknown[] } | undefined;
      if (options?.avoidCircles) throw new Error("no detour here");
      return (original as (...a: unknown[]) => unknown)(...args);
    }) as never;
    const response = await runRouteCheck(fakeClient(), parseRequest({}), providers, NOW);
    expect(response.traffic?.status).toBe("ok");
    expect(response.traffic?.call.decision).toBe("stay");
    expect(response.traffic?.call.reason).toContain("no truck-checked detour");
  });
});
