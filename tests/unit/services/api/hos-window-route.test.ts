// Reliability Unit B (design B.2.4/B.4.4, F-013): GET
// /api/v1/duty-logs/window. Pins the properties the old summary path
// violated: the query window opens at the carrier-anchored period
// (cycle + 2) periods back, rows come back started_at ASCENDING with
// no 200-row cap, the response carries the computed cycle summary and
// the window actually used, and an over-full window fails explicitly
// instead of returning a partial (understated) total.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/services/auth", () => ({
  getAuthContext: vi.fn().mockResolvedValue({
    userId: "u1",
    companyId: "company-1",
    role: "owner",
  }),
}));

vi.mock("@/services/db/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/services/db/server";
import { GET } from "@/app/api/v1/duty-logs/window/route";

interface Captured {
  gteArgs: unknown[];
  orderArgs: unknown[];
  limitArg: unknown;
  companyEq: unknown[];
}

function mockSupabase(rows: Record<string, unknown>[], captured: Captured) {
  return {
    from: (table: string) => {
      if (table === "companies") {
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: () => builder,
          single: async () => ({
            data: {
              hos_cycle: "70/8",
              hos_period_anchor: "06:00",
              hos_restart_enabled: true,
              hos_carrier_timezone: "America/New_York",
            },
            error: null,
          }),
        };
        return builder;
      }
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (...args: unknown[]) => {
          captured.companyEq = args;
          return builder;
        },
        is: () => builder,
        gte: (...args: unknown[]) => {
          captured.gteArgs = args;
          return builder;
        },
        order: (...args: unknown[]) => {
          captured.orderArgs = args;
          return builder;
        },
        limit: (n: unknown) => {
          captured.limitArg = n;
          return builder;
        },
        then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }),
      };
      return builder;
    },
  };
}

function useRows(rows: Record<string, unknown>[], captured: Captured) {
  vi.mocked(createClient).mockResolvedValue(mockSupabase(rows, captured) as never);
}

describe("GET /api/v1/duty-logs/window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Jan 15 2026, 15:00 EST. With anchor 06:00 the current period
    // began Jan 15 11:00Z; the 70/8 window opens 10 periods earlier.
    vi.setSystemTime(new Date("2026-01-15T20:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the query at the carrier-anchored window start, ascending, company-scoped", async () => {
    const captured: Captured = { gteArgs: [], orderArgs: [], limitArg: undefined, companyEq: [] };
    useRows([], captured);
    const res = await GET(new NextRequest("http://localhost/api/v1/duty-logs/window"));
    expect(res.status).toBe(200);
    expect(captured.gteArgs).toEqual(["started_at", "2026-01-05T11:00:00.000Z"]);
    expect(captured.orderArgs).toEqual(["started_at", { ascending: true }]);
    expect(captured.companyEq).toEqual(["company_id", "company-1"]);
    expect(captured.limitArg).toBe(5001); // tripwire probe, not a page size

    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.hos.carrierTimeZone).toBe("America/New_York");
    expect(body.hos.periodAnchor).toBe("06:00");
    expect(body.hos.currentPeriodStart).toBe("2026-01-15T11:00:00.000Z");
    expect(body.hos.windowStart).toBe("2026-01-08T11:00:00.000Z"); // counted span start (P-7)
    expect(body.hos.onDutyMinutesInCycle).toBe(0);
  });

  it("B.4.4: all 250 in-window logs are returned and summed - no 200 cap anywhere", async () => {
    const captured: Captured = { gteArgs: [], orderArgs: [], limitArg: undefined, companyEq: [] };
    // 250 alternating events, 30 min apart, from Jan 10 2026 00:00 EST
    // (inside the counted span, which opens Jan 8 06:00 EST; the last
    // event lands Jan 15 04:30 EST, before the frozen "now"):
    // 125 on-duty segments x 30 min = 3750 minutes.
    const rows: Record<string, unknown>[] = [];
    const startMs = Date.parse("2026-01-10T05:00:00Z");
    for (let i = 0; i < 250; i++) {
      rows.push({
        id: `log-${i}`,
        duty_status: i % 2 === 0 ? "on_duty" : "off_duty",
        started_at: new Date(startMs + i * 30 * 60_000).toISOString(),
      });
    }
    useRows(rows, captured);
    const res = await GET(new NextRequest("http://localhost/api/v1/duty-logs/window"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(250);
    expect(body.hos.onDutyMinutesInCycle).toBe(3750);
  });

  it("an over-full window fails explicitly (500) instead of returning a partial total", async () => {
    const captured: Captured = { gteArgs: [], orderArgs: [], limitArg: undefined, companyEq: [] };
    const rows = Array.from({ length: 5001 }, (_, i) => ({
      id: `log-${i}`,
      duty_status: "on_duty",
      started_at: "2026-01-12T05:00:00Z",
    }));
    useRows(rows, captured);
    const res = await GET(new NextRequest("http://localhost/api/v1/duty-logs/window"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("HOS_WINDOW_TOO_LARGE");
  });
});
