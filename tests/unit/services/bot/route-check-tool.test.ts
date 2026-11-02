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
    // Piece 1 fields the response type now requires — neutral values
    // (no life lines, no start leave-by) so existing cases are unchanged.
    lifeLines: [],
    paidLines: ["This load pays $2,000.00 over 500 miles - $4.00 a mile, before fuel and the drive back out."],
    tradeoffLines: ["Leaving at 7:00 AM gets you there 1h 30m after the window closes."],
    makeItDepartureAt: "2026-11-01T10:30:00.000Z",
    leaveStartByAt: null,
  },
  plan: {
    arrivalAt: "2026-11-01T23:30:00.000Z",
    totalElapsedMinutes: 690,
    breaks: [{ startAt: "2026-11-01T16:00:00.000Z", afterDrivingMinutes: 240, durationMinutes: 30, kind: "break" }],
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
    workout: null,
  },
  deadhead: null,
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
        estimatedPricePerGallonCents: null,
        estimateLabel: null,
        usedEstimate: false,
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

// --- Piece 1 parity (P1-6/P1-7/P1-9) — added cases only -------------

type ToolDeps = NonNullable<Parameters<typeof buildRouteCheckTool>[1]>;

const DEADHEAD_RESULT = {
  ...LATE_RESULT,
  deadhead: {
    startLabel: "Melbourne, FL",
    startPoint: { lat: 28.08, lng: -80.6 },
    distanceMiles: 25.5,
    providerDurationMinutes: 40,
    provider: "Valhalla (truck costing)",
    truckLegal: true,
    geometry: [
      { lat: 28.08, lng: -80.6 },
      { lat: 28.2, lng: -80.7 },
    ],
    leaveByAt: "2026-11-01T09:00:00.000Z",
    pickupArrivalAt: "2026-11-01T09:45:00.000Z",
    waitMinutesAtPickup: 45,
  },
  verdict: {
    ...LATE_RESULT.verdict,
    lifeLines: [
      "Sleep lands inside your 10 PM–6 AM window.",
      "A 60-minute workout fits at your break.",
    ],
    leaveStartByAt: "2026-11-01T08:30:00.000Z",
  },
} as unknown as RouteCheckResponse;

const WORKOUT_PLACED_RESULT = {
  ...LATE_RESULT,
  plan: {
    ...LATE_RESULT.plan!,
    workout: {
      placed: true,
      startAt: "2026-11-01T16:00:00.000Z",
      durationMinutes: 60,
      placeName: "Anytime Fitness, I-75",
      placeKind: "gym",
      point: { lat: 32, lng: -83 },
      note: "Your break extends to fit it; arrival still inside the window.",
    },
  },
} as unknown as RouteCheckResponse;

const WORKOUT_UNPLACED_RESULT = {
  ...LATE_RESULT,
  plan: {
    ...LATE_RESULT.plan!,
    workout: {
      placed: false,
      startAt: null,
      durationMinutes: 60,
      placeName: null,
      placeKind: null,
      point: null,
      note: "No room for a 60-minute workout on this run: it would put you at the receiver 25 minutes after the window closes. It fits if you leave 25+ minutes earlier.",
    },
  },
} as unknown as RouteCheckResponse;

const ESTIMATE_FUEL_RESULT = {
  ...LATE_RESULT,
  fuel: {
    ...LATE_RESULT.fuel,
    candidates: [
      {
        ...LATE_RESULT.fuel.candidates[0],
        id: "map:Love's, I-75",
        name: "Love's, I-75",
        pricePerGallonCents: null,
        estimatedPricePerGallonCents: 392,
        estimateLabel: "EIA U.S. average, week of Oct 26",
        usedEstimate: true,
        source: "map",
        effectiveCostCents: 40500,
        savingsVsBaselineCents: null,
      },
    ],
  },
} as unknown as RouteCheckResponse;

describe("routeCheckToolArgs — Piece 1 parity fields", () => {
  it("accepts the start fields and the life object, with workout defaults filled", () => {
    const parsed = routeCheckToolArgs.parse({
      load_id: LOAD_ID,
      start_location: "Melbourne, FL",
      start_point: { lat: 28.08, lng: -80.6 },
      start_at: "2026-11-01T09:00:00Z",
      life: {
        sleep_start_hour: 22,
        sleep_end_hour: 6,
        workout: { want: true },
      },
    });
    expect(parsed.start_location).toBe("Melbourne, FL");
    expect(parsed.start_point).toEqual({ lat: 28.08, lng: -80.6 });
    expect(parsed.start_at).toBe("2026-11-01T09:00:00Z");
    expect(parsed.life?.workout).toEqual({
      want: true,
      minutes: 60,
      setting: "gym_preferred",
    });
  });

  it("rejects out-of-bounds workout minutes in the life object", () => {
    expect(() =>
      routeCheckToolArgs.parse({ load_id: LOAD_ID, life: { workout: { want: true, minutes: 10 } } }),
    ).toThrow();
    expect(() =>
      routeCheckToolArgs.parse({ load_id: LOAD_ID, life: { workout: { want: true, minutes: 200 } } }),
    ).toThrow();
  });

  it("rejects an out-of-range start_point and sleep hour", () => {
    expect(() =>
      routeCheckToolArgs.parse({ load_id: LOAD_ID, start_point: { lat: 91, lng: 0 } }),
    ).toThrow();
    expect(() =>
      routeCheckToolArgs.parse({ load_id: LOAD_ID, life: { sleep_start_hour: 24 } }),
    ).toThrow();
  });
});

describe("check_route tool — Piece 1 parity pass-through", () => {
  it("passes the start fields and life object through to the engine request", async () => {
    let captured: unknown = null;
    const runCheck = (async (_client: unknown, request: unknown) => {
      captured = request;
      return DEADHEAD_RESULT;
    }) as unknown as NonNullable<ToolDeps["runCheck"]>;
    const tool = buildRouteCheckTool(fakeStore(fakeEngineClient([])), {
      runCheck,
      now: () => NOW,
    });
    const text = await tool.run({
      load_id: LOAD_ID,
      start_location: "Melbourne, FL",
      start_point: { lat: 28.08, lng: -80.6 },
      start_at: "2026-11-01T09:00:00Z",
      life: {
        sleep_start_hour: 22,
        sleep_end_hour: 6,
        workout: { want: true, minutes: 60, setting: "gym_preferred" },
      },
    });
    expect(captured).toMatchObject({
      load_id: LOAD_ID,
      start_location: "Melbourne, FL",
      start_point: { lat: 28.08, lng: -80.6 },
      start_at: "2026-11-01T09:00:00Z",
      life: {
        sleep_start_hour: 22,
        sleep_end_hour: 6,
        workout: { want: true, minutes: 60, setting: "gym_preferred" },
      },
    });
    expect(text).toContain("Deadhead:");
  });
});

describe("formatRouteCheck — Piece 1 parity", () => {
  it("prints the deadhead line, the pickup wait, and the start leave-by when the block is present", () => {
    const text = formatRouteCheck(DEADHEAD_RESULT);
    expect(text).toContain("Deadhead: 25.5 mi from Melbourne, FL");
    expect(text).toContain("45m waiting at the pickup");
    expect(text).toContain("it counts on your 14");
    expect(text).toContain("Leave Melbourne, FL by");
  });

  it("prints no deadhead or life lines when the response carries none", () => {
    const text = formatRouteCheck(LATE_RESULT);
    expect(text).not.toContain("Deadhead:");
    expect(text).not.toContain("Your life on this run:");
  });

  it("prints the life lines under their heading, after the rested lines", () => {
    const text = formatRouteCheck(DEADHEAD_RESULT);
    expect(text).toContain("Your life on this run:");
    expect(text).toContain("Sleep lands inside your 10 PM–6 AM window.");
    expect(text.indexOf("Your life on this run:")).toBeGreaterThan(text.indexOf("Rested:"));
    expect(text.indexOf("Your life on this run:")).toBeLessThan(text.indexOf("Paid:"));
  });

  it("prints a placed workout with its place and note", () => {
    const text = formatRouteCheck(WORKOUT_PLACED_RESULT);
    expect(text).toContain("Workout: 60 min at Anytime Fitness, I-75");
    expect(text).toContain("arrival still inside the window");
  });

  it("prints an unplaced workout with its reason — never silently dropped", () => {
    const text = formatRouteCheck(WORKOUT_UNPLACED_RESULT);
    expect(text).toContain("Workout: not placed");
    expect(text).toContain("25 minutes after the window closes");
  });

  it("speaks an estimate-ranked fuel candidate as an estimate, not a station price", () => {
    const text = formatRouteCheck(ESTIMATE_FUEL_RESULT);
    const fuelLine = text.split("\n").find((line) => line.includes("Love's, I-75"));
    expect(fuelLine).toBeDefined();
    expect(fuelLine).toContain("est.");
  });
});
