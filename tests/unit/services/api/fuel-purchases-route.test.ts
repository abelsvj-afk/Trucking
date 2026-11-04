// Reliability Unit C (design C.4/C.6, C.7.5/5b): the fuel write
// contract at the real routes. The total is derived - a supplied
// total that disagrees is a field-level 422, an adjustment without a
// reason is a 422, gallons past 3 decimals is a 422 - and the stored
// row always carries the derived total. Driven through the actual
// CRUD routes with a stateful Supabase mock.

import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { POST } from "@/app/api/v1/fuel-purchases/route";
import { PATCH } from "@/app/api/v1/fuel-purchases/[id]/route";

const TRUCK_ID = "11111111-1111-4111-8111-111111111111";

interface Captured {
  inserted: Record<string, unknown> | null;
  updated: Record<string, unknown> | null;
}

function mockSupabase(existing: Record<string, unknown> | null, captured: Captured) {
  return {
    from: () => {
      let op: "insert" | "update" | "select" = "select";
      let values: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        insert: (v: Record<string, unknown>) => {
          op = "insert";
          values = v;
          return builder;
        },
        update: (v: Record<string, unknown>) => {
          op = "update";
          values = v;
          return builder;
        },
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        order: () => builder,
        range: () => builder,
        limit: () => builder,
        gte: () => builder,
        lte: () => builder,
        lt: () => builder,
        neq: () => builder,
        single: async () => {
          if (op === "insert") {
            captured.inserted = values;
            return { data: { id: "new-id", ...values }, error: null };
          }
          return { data: existing, error: null };
        },
        maybeSingle: async () => {
          if (op === "update") {
            captured.updated = values;
            return { data: { ...(existing ?? {}), ...values }, error: null };
          }
          return { data: existing, error: null };
        },
      };
      return builder;
    },
  };
}

let captured: Captured;
let existing: Record<string, unknown> | null;

beforeEach(() => {
  captured = { inserted: null, updated: null };
  existing = null;
  vi.mocked(createClient).mockImplementation(
    async () => mockSupabase(existing, captured) as never,
  );
});

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/v1/fuel-purchases", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function patchReq(id: string, body: unknown) {
  return new NextRequest(`http://localhost/api/v1/fuel-purchases/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const routeCtx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("POST /api/v1/fuel-purchases (C.7.5)", () => {
  it("rejects a free-typed total that disagrees with gallons x price, no adjustment: 422 with the field named", async () => {
    const res = await POST(
      postReq({
        truck_id: TRUCK_ID,
        gallons: 100,
        price_per_gallon_cents: 350,
        total_cost_cents: 50000,
        purchased_at: "2026-11-10",
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.fields?.map((f: { path: string }) => f.path)).toContain("total_cost_cents");
    expect(captured.inserted).toBeNull();
  });

  it("accepts the same total as a justified adjustment: base 35000 + 15000 = 50000 stored", async () => {
    const res = await POST(
      postReq({
        truck_id: TRUCK_ID,
        gallons: 100,
        price_per_gallon_cents: 350,
        adjustment_cents: 15000,
        adjustment_reason: "Receipt included taxes",
        purchased_at: "2026-11-10",
      }),
    );
    expect(res.status).toBe(201);
    expect(captured.inserted?.total_cost_cents).toBe(50000);
    expect(captured.inserted?.adjustment_cents).toBe(15000);
    expect(captured.inserted?.adjustment_reason).toBe("Receipt included taxes");
  });

  it("rejects a nonzero adjustment with no reason: 422", async () => {
    const res = await POST(
      postReq({
        truck_id: TRUCK_ID,
        gallons: 100,
        price_per_gallon_cents: 350,
        adjustment_cents: 15000,
        purchased_at: "2026-11-10",
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.fields?.map((f: { path: string }) => f.path)).toContain("adjustment_reason");
    expect(captured.inserted).toBeNull();
  });

  it("derives the total when the client supplies none - and accepts a correct echo", async () => {
    const derived = await POST(
      postReq({
        truck_id: TRUCK_ID,
        gallons: 100,
        price_per_gallon_cents: 350,
        purchased_at: "2026-11-10",
      }),
    );
    expect(derived.status).toBe(201);
    expect(captured.inserted?.total_cost_cents).toBe(35000);

    const echo = await POST(
      postReq({
        truck_id: TRUCK_ID,
        gallons: 100,
        price_per_gallon_cents: 350,
        total_cost_cents: 35000,
        purchased_at: "2026-11-10",
      }),
    );
    expect(echo.status).toBe(201);
  });

  it("C.7.5b at the API: gallons with 4 decimal places is a 422, never a silent rounding", async () => {
    const res = await POST(
      postReq({
        truck_id: TRUCK_ID,
        gallons: 2.6755,
        price_per_gallon_cents: 100,
        purchased_at: "2026-11-10",
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.fields?.map((f: { path: string }) => f.path)).toContain("gallons");
    expect(captured.inserted).toBeNull();
  });
});

describe("PATCH /api/v1/fuel-purchases/[id] (derived total on update)", () => {
  beforeEach(() => {
    existing = {
      id: "22222222-2222-4222-8222-222222222222",
      company_id: "company-1",
      truck_id: TRUCK_ID,
      location: null,
      gallons: 100,
      price_per_gallon_cents: 350,
      total_cost_cents: 35000,
      adjustment_cents: 0,
      adjustment_reason: null,
      purchased_at: "2026-11-10T00:00:00.000Z",
      deleted_at: null,
    };
  });

  it("re-derives the total when only gallons change - the patch never mentions a total", async () => {
    const res = await PATCH(patchReq("22222222-2222-4222-8222-222222222222", { gallons: 50 }), routeCtx("22222222-2222-4222-8222-222222222222"));
    expect(res.status).toBe(200);
    expect(captured.updated?.total_cost_cents).toBe(17500);
  });

  it("keeps a legacy adjustment intact across an unrelated edit (total stays base + legacy adjustment)", async () => {
    existing = {
      ...existing,
      total_cost_cents: 50000,
      adjustment_cents: 15000,
      adjustment_reason: "Legacy variance (pre-F-053)",
    };
    const res = await PATCH(patchReq("22222222-2222-4222-8222-222222222222", { location: "Pilot #44" }), routeCtx("22222222-2222-4222-8222-222222222222"));
    expect(res.status).toBe(200);
    expect(captured.updated?.total_cost_cents).toBe(50000);
  });

  it("rejects setting an adjustment without a reason via the merged record: 422", async () => {
    const res = await PATCH(patchReq("22222222-2222-4222-8222-222222222222", { adjustment_cents: 2000 }), routeCtx("22222222-2222-4222-8222-222222222222"));
    expect(res.status).toBe(422);
    expect(captured.updated).toBeNull();
  });
});
