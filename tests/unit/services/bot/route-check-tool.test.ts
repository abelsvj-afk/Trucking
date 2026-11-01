// §13: the Smart Path route check as an agent tool.
// - The argument schema is the engine's own contract, Zod-checked.
// - formatRouteCheck passes the engine's verdict and its own lines
//   through verbatim — it formats, never derives.
// - The tool runs the REAL engine (fake Supabase + fake providers)
//   and scopes every read to the store's company in code, because
//   the Telegram surface's client is service-role (no RLS).

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildRouteCheckTool,
  formatRouteCheck,
  routeCheckToolArgs,
} from "@/services/bot/route-check-tool";
import { buildBotTools } from "@/services/bot/tools";
import type { BotBrainStore } from "@/services/bot/store";
import type { RouteCheckProviders } from "@/services/smart-path/route-check";
import type { RouteCheckResponse } from "@/types/smart-path";

const COMPANY = "75efa4a5-a126-467d-b82a-c32a12628dba";
const LOAD_ID = "16161616-1616-4616-8616-161616161616";
const NOW = new Date("2026-11-01T12:00:00Z");

const LATE_RESULT: RouteCheckResponse = {
  load: { id: LOAD_ID, origin: "Melbourne, FL", destination: "Atlanta, GA", status: "confirmed" },
  route: {
    provider: "OpenRouteService driving-hgv",
    truckLegal: true,
    distanceMiles: 460.5,
    providerDurationMinutes: 512,
    geometry: [
      { lat: 28.08, lng: -80.6 },
      { lat: 33.75, lng: -84.39 },
    ],
    originPoint: { lat: 28.08, lng: -80.6 },
    destinationPoint: { lat: 33.75, lng: -84.39 },
  },
  verdict: {
    status: "late",
    assumedDriveMinutes: 540,
    driveTimeBasis: "truck profile speed (55 mph governed)",
    legalLines: ["Legal: the drive fits inside the 11-hour driving limit."],
    restedLines: ["Rested: one sleep stop is planned the night before delivery."],
    paidLines: ["This load pays $2,000.00 over 500 miles - $4.00 a mile, before fuel and the drive back out."],
    tradeoffLines: ["Leaving at 7:00 AM gets you there 1h 30m after the window closes."],
    makeItDepartureAt: "2026-11-01T10:30:00.000Z",
  },
  plan: {
    arrivalAt: "2026-11-01T23:30:00.000Z",
    totalElapsedMinutes: 690,
    breaks: [{ startAt: "2026-11-01T16:00:00.000Z", afterDrivingMinutes: 240 }],
    rests: [
      {
        startAt: "2026-11-01T18:00:00.000Z",
        endAt: "2026-11-02T04:00:00.000Z",
        distanceMilesFromOrigin: 210,
        fractionOfRoute: 0.45,
        startHourEastern: 13,
        point: { lat: 31, lng: -82 },
      },
    ],
  },
  fuel: {
    assumptions: {
      gallonsToBuy: 100,
      avgMpg: 6.5,
      valueOfTimeCentsPerHour: 2500,
      stopMinutes: 30,
      baselinePriceCents: 399,
    },
    candidates: [
      {
        id: "history:Pilot, I-75",
        name: "Pilot, I-75",
        lat: 32,
        lng: -83,
        pricePerGallonCents: 389,
        source: "history",
        detourMiles: 0,
        pumpCostCents: 38900,
        detourCostCents: 1250,
        effectiveCostCents: 40150,
        savingsVsBaselineCents: -250,
      },
    ],
    unavailableReason: null,
  },
  food: {
    mode: "grocery",
    groceryPlan: null,
    stops: [],
    suppressedByFast: [],
    lines: ["Grocery stop fits before the fast window."],
    unavailableReason: null,
  },
  warnings: ["Route geometry came from OpenRouteService driving-hgv."],
};

describe("routeCheckToolArgs", () => {
  it("accepts the minimal engine input", () => {
    expect(routeCheckToolArgs.parse({ load_id: LOAD_ID }).load_id).toBe(LOAD_ID);
  });

  it("rejects a non-uuid load_id", () => {
    expect(() => routeCheckToolArgs.parse({ load_id: "not-a-load" })).toThrow();
  });

  it("rejects a window whose start is after its end", () => {
    expect(() =>
      routeCheckToolArgs.parse({
        load_id: LOAD_ID,
        delivery_window: { start: "2026-11-02T10:00:00Z", end: "2026-11-02T09:00:00Z" },
      }),
    ).toThrow();
  });

  it("rejects a non-ISO departure and an impossible gallon count", () => {
    expect(() => routeCheckToolArgs.parse({ load_id: LOAD_ID, depart_at: "tomorrow" })).toThrow();
    expect(() => routeCheckToolArgs.parse({ load_id: LOAD_ID, gallons_to_buy: 900 })).toThrow();
  });
});

describe("formatRouteCheck", () => {
  it("passes the verdict, the engine's lines, and its figures through verbatim", () => {
    const text = formatRouteCheck(LATE_RESULT);
    expect(text).toContain("Route check — Melbourne, FL → Atlanta, GA (load confirmed):");
    expect(text).toContain("Verdict: LATE");
    expect(text).toContain("460.5 miles via OpenRouteService driving-hgv (truck-checked route: yes)");
    expect(text).toContain("Legal: the drive fits inside the 11-hour driving limit.");
    expect(text).toContain("Rested: one sleep stop is planned");
    expect(text).toContain("$4.00 a mile");
    expect(text).toContain("Leave by 2026-11-01T10:30:00.000Z");
    expect(text).toContain("Rest near mile 210: 2026-11-01T18:00:00.000Z → 2026-11-02T04:00:00.000Z.");
    expect(text).toContain("Pilot, I-75: $3.89/gal, effective $401.50");
    expect(text).toContain("Food: Grocery stop fits before the fast window.");
    expect(text).toContain("Warning: Route geometry came from OpenRouteService driving-hgv.");
  });

  it("renders NOT LEGAL with no plan as no legal plan — not a softened verdict", () => {
    const text = formatRouteCheck({
      ...LATE_RESULT,
      verdict: { ...LATE_RESULT.verdict, status: "not_legal", makeItDepartureAt: null },
      plan: null,
    });
    expect(text).toContain("Verdict: NOT LEGAL");
    expect(text).toContain("no legal plan exists for this departure");
  });
});

// --- the tool over the REAL engine, with a fake Supabase ------------

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: { col: string; val: unknown }[] = [];
  constructor(
    private rows: Row[],
    private table: string,
    private recorder: { table: string; col: string; val: unknown }[],
  ) {}
  select() {
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ col, val });
    this.recorder.push({ table: this.table, col, val });
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

function fakeEngineClient(recorder: { table: string; col: string; val: unknown }[]) {
  const tables: Record<string, Row[]> = {
    loads: [
      {
        id: LOAD_ID,
        company_id: COMPANY,
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
    from: (table: string) => new FakeQuery(tables[table] ?? [], table, recorder),
  } as unknown as SupabaseClient;
}

const fakeProviders = {
  geocoding: { geocode: async () => ({ lat: 30, lng: -82 }) },
  routing: {
    getRoute: async () => ({
      distanceMiles: 400,
      durationMinutes: 400,
      geometry: [
        { lat: 28, lng: -80 },
        { lat: 33, lng: -84 },
      ],
      providerName: "Valhalla (truck costing)",
      truckLegal: true,
      providerNotes: [],
    }),
  },
  places: { findNear: async () => [] },
} as unknown as RouteCheckProviders;

function fakeStore(client: SupabaseClient): BotBrainStore {
  return { client, companyId: COMPANY, channel: "telegram" } as unknown as BotBrainStore;
}

describe("check_route tool", () => {
  it("runs the real engine end to end and reports its verdict", async () => {
    const recorder: { table: string; col: string; val: unknown }[] = [];
    const tool = buildRouteCheckTool(fakeStore(fakeEngineClient(recorder)), {
      providers: fakeProviders,
      now: () => NOW,
    });
    const text = await tool.run({
      load_id: LOAD_ID,
      delivery_window: { start: "2026-11-03T00:00:00Z", end: "2026-11-03T12:00:00Z" },
    });
    expect(text).toContain("Route check — Melbourne, FL → Atlanta, GA");
    expect(text).toMatch(/Verdict: (ON TIME|EARLY)/);
    expect(text).toContain("Valhalla (truck costing)");
    expect(text).toContain("truck-checked route: yes");
    expect(text).toContain("$4.00 a mile");
  });

  it("scopes every engine read to the store's company in code", async () => {
    const recorder: { table: string; col: string; val: unknown }[] = [];
    const tool = buildRouteCheckTool(fakeStore(fakeEngineClient(recorder)), {
      providers: fakeProviders,
      now: () => NOW,
    });
    await tool.run({ load_id: LOAD_ID });
    for (const table of ["loads", "duty_logs", "fuel_purchases"]) {
      expect(
        recorder.some((r) => r.table === table && r.col === "company_id" && r.val === COMPANY),
        `expected a company_id filter on ${table}`,
      ).toBe(true);
    }
  });

  it("refuses a load that isn't in his records (the engine's own 404, surfaced)", async () => {
    const recorder: { table: string; col: string; val: unknown }[] = [];
    const tool = buildRouteCheckTool(fakeStore(fakeEngineClient(recorder)), {
      providers: fakeProviders,
      now: () => NOW,
    });
    await expect(
      tool.run({ load_id: "99999999-9999-4999-8999-999999999999" }),
    ).rejects.toThrow("could not be found");
  });

  it("is registered in the bot's tool registry as a read tool", () => {
    const recorder: { table: string; col: string; val: unknown }[] = [];
    const tools = buildBotTools(fakeStore(fakeEngineClient(recorder)));
    const found = tools.find((t) => t.name === "check_route");
    expect(found).toBeDefined();
    expect(found!.access).toBe("read");
  });
});
