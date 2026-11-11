// UI/UX Phase 4 (spec §2.4): GET/PUT /api/v1/preferences — the web
// door onto person_preferences for subject_type='owner'. Mirrors the
// hos-settings route test's approach (mocked auth + mocked Supabase
// client). Pins: PUT→GET round-trip, single-key reads, validation
// 400s, and tenant scoping — another company's rows are never read
// or written because every query carries company_id.

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
import { GET, PUT } from "@/app/api/v1/preferences/route";

interface Row {
  company_id: string;
  subject_type: string;
  driver_id: string | null;
  key: string;
  value: unknown;
  source?: string;
  deleted_at?: string | null;
  [k: string]: unknown;
}

function mockSupabase(store: { rows: Row[] }) {
  return {
    from: () => {
      const filters: [string, unknown][] = [];
      let mode: "select" | "update" | "insert" = "select";
      let patch: Record<string, unknown> | null = null;
      let insertRow: Row | null = null;
      // The route always filters deleted_at IS NULL itself, so plain
      // filter application is faithful here.
      const matching = () =>
        store.rows.filter((r) =>
          filters.every(([c, v]) => (v === null ? (r[c] ?? null) === null : r[c] === v)),
        );
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (c: string, v: unknown) => {
          filters.push([c, v]);
          return builder;
        },
        is: (c: string, v: unknown) => {
          filters.push([c, v]);
          return builder;
        },
        update: (p: Record<string, unknown>) => {
          mode = "update";
          patch = p;
          return builder;
        },
        insert: (row: Row) => {
          mode = "insert";
          insertRow = row;
          return builder;
        },
        then: (resolve: (v: unknown) => void) => {
          if (mode === "insert") {
            store.rows.push({ deleted_at: null, ...insertRow! });
            resolve({ data: null, error: null });
          } else if (mode === "update") {
            for (const row of matching()) Object.assign(row, patch!);
            resolve({ data: null, error: null });
          } else {
            resolve({ data: matching(), error: null });
          }
        },
      };
      return builder;
    },
  };
}

function useStore(store: { rows: Row[] }) {
  vi.mocked(createClient).mockResolvedValue(mockSupabase(store) as never);
}

function putReq(body: unknown) {
  return new NextRequest("http://localhost/api/v1/preferences", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("/api/v1/preferences", () => {
  it("PUT then GET round-trips one key, stored as an owner stated preference", async () => {
    const store = { rows: [] as Row[] };
    useStore(store);
    const put = await PUT(putReq({ key: "home_map_collapsed", value: { collapsed: true } }));
    expect(put.status).toBe(200);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      company_id: "company-1",
      subject_type: "owner",
      driver_id: null,
      key: "home_map_collapsed",
      value: { collapsed: true },
      source: "stated",
    });

    const get = await GET(new NextRequest("http://localhost/api/v1/preferences?key=home_map_collapsed"));
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ key: "home_map_collapsed", value: { collapsed: true } });
  });

  it("a second PUT updates the same live row instead of duplicating it", async () => {
    const store = { rows: [] as Row[] };
    useStore(store);
    await PUT(putReq({ key: "home_map_collapsed", value: { collapsed: true } }));
    await PUT(putReq({ key: "home_map_collapsed", value: { collapsed: false } }));
    expect(store.rows).toHaveLength(1);
    const get = await GET(new NextRequest("http://localhost/api/v1/preferences?key=home_map_collapsed"));
    expect((await get.json()).value).toEqual({ collapsed: false });
  });

  it("GET without a key returns the caller's whole owner preference map", async () => {
    const store = {
      rows: [
        { company_id: "company-1", subject_type: "owner", driver_id: null, key: "a", value: 1 },
        { company_id: "company-1", subject_type: "owner", driver_id: null, key: "b", value: { x: true } },
      ] as Row[],
    };
    useStore(store);
    const res = await GET(new NextRequest("http://localhost/api/v1/preferences"));
    expect(await res.json()).toEqual({ preferences: { a: 1, b: { x: true } } });
  });

  it("tenant scoping: another company's (and driver-subject) rows are invisible and untouched", async () => {
    const store = {
      rows: [
        { company_id: "company-2", subject_type: "owner", driver_id: null, key: "home_map_collapsed", value: { collapsed: true } },
        { company_id: "company-1", subject_type: "driver", driver_id: "d1", key: "home_map_collapsed", value: { collapsed: true } },
      ] as Row[],
    };
    useStore(store);
    const get = await GET(new NextRequest("http://localhost/api/v1/preferences?key=home_map_collapsed"));
    expect((await get.json()).value).toBeNull();
    await PUT(putReq({ key: "home_map_collapsed", value: { collapsed: false } }));
    // The other company's row and the driver row keep their values;
    // the write landed as a NEW owner row for company-1.
    expect(store.rows.find((r) => r.company_id === "company-2")!.value).toEqual({ collapsed: true });
    expect(store.rows.find((r) => r.subject_type === "driver")!.value).toEqual({ collapsed: true });
    expect(
      store.rows.find((r) => r.company_id === "company-1" && r.subject_type === "owner")!.value,
    ).toEqual({ collapsed: false });
  });

  it("validation: missing/blank key and missing value are 400s that write nothing", async () => {
    const store = { rows: [] as Row[] };
    useStore(store);
    for (const body of [{}, { value: 1 }, { key: "" }, { key: "   ", value: 1 }, { key: "x" }]) {
      const res = await PUT(putReq(body));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    }
    expect(store.rows).toHaveLength(0);
  });

  it("GET of an unset key is value null, not an error", async () => {
    useStore({ rows: [] });
    const res = await GET(new NextRequest("http://localhost/api/v1/preferences?key=never_set"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "never_set", value: null });
  });
});
