// Computed, read-only endpoint (docs/api-contracts.md) - not backed by a
// table, so no createCrudRoutes coverage applies. Tests the aggregation
// math directly (the actual logic worth getting wrong, per
// docs/design/testing.md) with a per-table mocked Supabase client.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/services/auth", () => ({
  getAuthContext: vi.fn().mockResolvedValue({
    userId: "u1",
    companyId: "company-1",
    role: "owner",
  }),
}));

function mockSupabase(resultsByTable: Record<string, { data?: unknown; error?: unknown }>) {
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> & { then: (resolve: (v: unknown) => void) => void } = {
        select: () => builder,
        in: () => builder,
        is: () => builder,
        gte: () => builder,
        lte: () => builder,
        lt: () => builder,
        then: (resolve: (v: unknown) => void) => resolve(resultsByTable[table] ?? { data: [] }),
      };
      return builder;
    },
  };
}

vi.mock("@/services/db/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/services/db/server";
import { GET } from "@/app/api/v1/financial-summary/route";

describe("GET /api/v1/financial-summary", () => {
  it("rejects a malformed date", async () => {
    vi.mocked(createClient).mockResolvedValue(mockSupabase({}) as never);
    const res = await GET(
      new NextRequest("http://localhost/api/v1/financial-summary?from=08-01-2026&to=2026-08-31"),
    );
    expect(res.status).toBe(400);
  });

  it("rejects from after to", async () => {
    vi.mocked(createClient).mockResolvedValue(mockSupabase({}) as never);
    const res = await GET(
      new NextRequest("http://localhost/api/v1/financial-summary?from=2026-08-31&to=2026-08-01"),
    );
    expect(res.status).toBe(400);
  });

  it("computes revenue/expenses/fuel/maintenance/net for a given range", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({
        loads: {
          data: [
            { rate_cents: 500000, pickup_date: "2026-08-05", delivery_date: "2026-08-07" },
            { rate_cents: 300000, pickup_date: "2026-08-20", delivery_date: null },
          ],
        },
        expenses: { data: [{ amount_cents: 10000 }, { amount_cents: 5000 }] },
        fuel_purchases: { data: [{ total_cost_cents: 40000 }] },
        maintenance_events: { data: [{ cost_cents: 20000 }] },
      }) as never,
    );

    const res = await GET(
      new NextRequest("http://localhost/api/v1/financial-summary?from=2026-08-01&to=2026-08-31"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      range: { from: "2026-08-01", to: "2026-08-31" },
      revenue_cents: 800000,
      expenses_cents: 15000,
      fuel_cents: 40000,
      maintenance_cents: 20000,
      net_cents: 800000 - 15000 - 40000 - 20000,
    });
  });

  it("excludes a load with neither delivery_date nor pickup_date set", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({
        loads: {
          data: [{ rate_cents: 999999, pickup_date: null, delivery_date: null }],
        },
        expenses: { data: [] },
        fuel_purchases: { data: [] },
        maintenance_events: { data: [] },
      }) as never,
    );

    const res = await GET(
      new NextRequest("http://localhost/api/v1/financial-summary?from=2026-08-01&to=2026-08-31"),
    );

    const body = await res.json();
    expect(body.revenue_cents).toBe(0);
  });

  it("excludes a load whose effective date falls outside the requested range", async () => {
    vi.mocked(createClient).mockResolvedValue(
      mockSupabase({
        loads: {
          data: [{ rate_cents: 999999, pickup_date: "2026-07-31", delivery_date: null }],
        },
        expenses: { data: [] },
        fuel_purchases: { data: [] },
        maintenance_events: { data: [] },
      }) as never,
    );

    const res = await GET(
      new NextRequest("http://localhost/api/v1/financial-summary?from=2026-08-01&to=2026-08-31"),
    );

    const body = await res.json();
    expect(body.revenue_cents).toBe(0);
  });

  describe("default range (from/to omitted)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("defaults to the current calendar month", async () => {
      vi.mocked(createClient).mockResolvedValue(
        mockSupabase({
          loads: { data: [] },
          expenses: { data: [] },
          fuel_purchases: { data: [] },
          maintenance_events: { data: [] },
        }) as never,
      );

      const res = await GET(new NextRequest("http://localhost/api/v1/financial-summary"));
      const body = await res.json();

      expect(body.range).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    });
  });
});
