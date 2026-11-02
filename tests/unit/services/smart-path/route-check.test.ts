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
