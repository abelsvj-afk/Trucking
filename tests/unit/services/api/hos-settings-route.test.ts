// Reliability Unit B (design B.5): GET/PATCH /api/v1/hos-settings.
// Mirrors the ai-settings route's test approach - a mocked Supabase
// client over the companies row. Pins: stored values round-trip,
// pre-migration reads fall back to the labeled provisional defaults,
// invalid values are refused with FIELD-NAMED errors, and a
// pre-migration write fails explicitly instead of pretending to save.

import { describe, expect, it, vi } from "vitest";
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
import { GET, PATCH } from "@/app/api/v1/hos-settings/route";

interface FakeState {
  row: Record<string, unknown>;
  selectError: { code: string; message: string } | null;
  updateError: { code: string; message: string } | null;
}

function mockSupabase(state: FakeState) {
  return {
    from: () => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        update: (patch: Record<string, unknown>) => {
          if (!state.updateError) Object.assign(state.row, patch);
          return builder;
        },
        single: async () =>
          state.selectError ? { data: null, error: state.selectError } : { data: state.row, error: null },
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: null, error: state.updateError }),
      };
      return builder;
    },
  };
}

function freshState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    row: {
      hos_cycle: "70/8",
      hos_period_anchor: "00:00",
      hos_restart_enabled: true,
      hos_carrier_timezone: "America/New_York",
    },
    selectError: null,
    updateError: null,
    ...overrides,
  };
}

function useState(state: FakeState) {
  vi.mocked(createClient).mockResolvedValue(mockSupabase(state) as never);
}

const PRE_MIGRATION = { code: "42703", message: "column companies.hos_cycle does not exist" };

describe("GET /api/v1/hos-settings", () => {
  it("returns the stored carrier configuration", async () => {
    useState(
      freshState({
        row: {
          hos_cycle: "60/7",
          hos_period_anchor: "06:00",
          hos_restart_enabled: false,
          hos_carrier_timezone: "America/Chicago",
        },
      }),
    );
    const res = await GET(new NextRequest("http://localhost/api/v1/hos-settings"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      hos_cycle: "60/7",
      hos_period_anchor: "06:00",
      hos_restart_enabled: false,
      hos_carrier_timezone: "America/Chicago",
    });
  });

  it("pre-migration (columns absent): reports the provisional defaults, does not fail", async () => {
    useState(freshState({ selectError: PRE_MIGRATION }));
    const res = await GET(new NextRequest("http://localhost/api/v1/hos-settings"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      hos_cycle: "70/8",
      hos_period_anchor: "00:00",
      hos_restart_enabled: true,
      hos_carrier_timezone: "America/New_York",
    });
  });
});

describe("PATCH /api/v1/hos-settings", () => {
  function patchReq(body: unknown) {
    return new NextRequest("http://localhost/api/v1/hos-settings", {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("applies a valid partial update and returns the new settings", async () => {
    const state = freshState();
    useState(state);
    const res = await PATCH(patchReq({ hos_period_anchor: "06:00", hos_cycle: "60/7" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hos_period_anchor).toBe("06:00");
    expect(body.hos_cycle).toBe("60/7");
    expect(body.hos_carrier_timezone).toBe("America/New_York"); // untouched field preserved
  });

  it("refuses an invalid anchor with a field-named error", async () => {
    useState(freshState());
    const res = await PATCH(patchReq({ hos_period_anchor: "25:00" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.fields[0].path).toBe("hos_period_anchor");
  });

  it("refuses an invalid timezone with a field-named error", async () => {
    useState(freshState());
    const res = await PATCH(patchReq({ hos_carrier_timezone: "Bogus/Zone" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.fields[0].path).toBe("hos_carrier_timezone");
  });

  it("refuses an unknown cycle and an unknown field", async () => {
    useState(freshState());
    const badCycle = await PATCH(patchReq({ hos_cycle: "80/9" }));
    expect(badCycle.status).toBe(400);
    const unknown = await PATCH(patchReq({ hos_something: true }));
    expect(unknown.status).toBe(400);
  });

  it("pre-migration write fails explicitly (500), never a silent no-save", async () => {
    useState(freshState({ updateError: PRE_MIGRATION }));
    const res = await PATCH(patchReq({ hos_period_anchor: "06:00" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("HOS_CONFIG_UNAVAILABLE");
  });
});
