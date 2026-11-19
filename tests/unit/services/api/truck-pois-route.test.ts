// POST /api/v1/smart-path/truck-pois (audit-fix B7). Drives the
// REAL route + REAL Overpass code path behind a stubbed fetch: the
// POIs on the remaining run, in miles from his position.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/services/auth", () => ({
  getAuthContext: vi.fn(async () => ({ userId: "u1", companyId: "c1", role: "owner" })),
}));

import { clearOverpassTruckPoisCache } from "@/services/integrations/overpass-truck-pois";
import { POST } from "@/app/api/v1/smart-path/truck-pois/route";

// Straight remaining run: 50 miles due north from (30, -82).
const GEOMETRY = Array.from({ length: 51 }, (_, i) => ({ lat: 30 + i * 0.01449, lng: -82 }));

beforeEach(() => clearOverpassTruckPoisCache());
afterEach(() => vi.unstubAllGlobals());

function overpassBody() {
  return {
    elements: [
      {
        type: "node",
        id: 201,
        lat: 30 + 9 * 0.01449,
        lon: -82,
        tags: { amenity: "fuel", name: "Love's" },
      },
      {
        type: "node",
        id: 202,
        lat: 30 + 20 * 0.01449,
        lon: -82,
        tags: { highway: "rest_area" },
      },
    ],
  };
}

async function post(body: unknown) {
  const req = new NextRequest("http://localhost/api/v1/smart-path/truck-pois", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await POST(req);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/v1/smart-path/truck-pois", () => {
  it("returns the POIs on the remaining run, in miles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => overpassBody() }) as Response),
    );
    const { status, body } = await post({ geometry: GEOMETRY, totalMiles: 50 });
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    const items = body.items as { id: string; kind: string; mile: number }[];
    expect(items.map((i) => i.id)).toEqual(["node/201", "node/202"]);
    expect(items[0]!.mile).toBeCloseTo(9, 0);
    expect(items[1]!.kind).toBe("rest");
  });

  it("degrades to unavailable when Overpass is down — never invented stops", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response),
    );
    const { status, body } = await post({ geometry: GEOMETRY, totalMiles: 50 });
    expect(status).toBe(200);
    expect(body.status).toBe("unavailable");
    expect(body.items).toEqual([]);
  });

  it("rejects a bad body", async () => {
    const { status } = await post({ geometry: [], totalMiles: 50 });
    expect(status).toBe(400);
  });
});
