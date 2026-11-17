// POST /api/v1/smart-path/live-traffic (live awareness, owner
// 2026-11-17). Drives the REAL route + REAL TomTom/Valhalla code
// paths behind mocked fetch: the traffic section, the reroute
// call, and the avoid circles for the one-tap detour.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/services/auth", () => ({
  getAuthContext: vi.fn(async () => ({ userId: "u1", companyId: "c1", role: "owner" })),
}));

import { clearTomTomTrafficCache } from "@/services/integrations/tomtom-traffic";
import { POST } from "@/app/api/v1/smart-path/live-traffic/route";

// Straight remaining run: 100 miles due north from (35, -90).
const GEOMETRY = Array.from({ length: 101 }, (_, i) => ({ lat: 35 + i * 0.01449, lng: -90 }));
const CORRIDOR = [
  { mile: 0, etaAt: "2026-11-17T12:00:00-06:00" },
  { mile: 50, etaAt: "2026-11-17T13:00:00-06:00" },
  { mile: 100, etaAt: "2026-11-17T14:00:00-06:00" },
];
const INCIDENT_POINT = { lat: 35 + 40 * 0.01449, lng: -90 };

function tomtomBody() {
  return {
    incidents: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [INCIDENT_POINT.lng, INCIDENT_POINT.lat] },
        properties: {
          id: "inc-1",
          iconCategory: 6,
          magnitudeOfDelay: 3,
          delay: 1800,
          events: [{ description: "Queue" }],
          endTime: "2026-11-17T14:00:00-06:00",
          from: "A",
          to: "B",
          length: 4000,
          roadNumbers: ["I-75"],
        },
      },
    ],
  };
}

function valhallaBody(detourMinutes: number) {
  return {
    trip: {
      status: 0,
      summary: { length: 105, time: detourMinutes * 60 },
      legs: [{ shape: "??", maneuvers: [] }],
    },
  };
}

function mockFetch(detourMinutes: number, incidents: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.tomtom.com")) {
      return { ok: true, status: 200, json: async () => incidents } as Response;
    }
    if (url.includes("valhalla1.openstreetmap.de")) {
      return { ok: true, status: 200, json: async () => valhallaBody(detourMinutes) } as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/v1/smart-path/live-traffic", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function baseBody(): Record<string, unknown> {
  return {
    geometry: GEOMETRY,
    totalMiles: 100,
    corridor: CORRIDOR,
    currentMile: 0,
    currentPoint: GEOMETRY[0],
    destination: GEOMETRY[GEOMETRY.length - 1],
    plannedRemainingMinutes: 120,
  };
}

const originalFetch = global.fetch;
const originalKey = process.env.TOMTOM_API_KEY;

beforeEach(() => {
  clearTomTomTrafficCache();
  process.env.TOMTOM_API_KEY = "test-key";
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  if (originalKey === undefined) delete process.env.TOMTOM_API_KEY;
  else process.env.TOMTOM_API_KEY = originalKey;
});

describe("POST /api/v1/smart-path/live-traffic", () => {
  it("returns the traffic section, a reroute call, and the avoid circles", async () => {
    global.fetch = mockFetch(120, tomtomBody()) as never;
    const res = await POST(request(baseBody()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      traffic: { status: string; items: unknown[]; segments: unknown[]; call: { decision: string; savesMinutes: number | null } };
      avoidCircles: { lat: number; lng: number; radiusMiles: number }[];
    };
    expect(body.traffic.status).toBe("ok");
    expect(body.traffic.items).toHaveLength(1);
    expect(body.traffic.segments).toHaveLength(1);
    // Staying costs 120 + 30 delay; the truck-checked detour is
    // 120 min, so it saves 30.
    expect(body.traffic.call.decision).toBe("reroute");
    expect(body.traffic.call.savesMinutes).toBe(30);
    expect(body.avoidCircles).toHaveLength(1);
    expect(body.avoidCircles[0]!.radiusMiles).toBeGreaterThanOrEqual(3);
  });

  it("stays when the detour is no faster, and says why", async () => {
    global.fetch = mockFetch(200, tomtomBody()) as never;
    const res = await POST(request(baseBody()));
    const body = (await res.json()) as {
      traffic: { call: { decision: string; reason: string } };
    };
    expect(body.traffic.call.decision).toBe("stay");
    expect(body.traffic.call.reason).toContain("only saves about 0 min");
  });

  it("is ok with no incidents, and the call is none", async () => {
    global.fetch = mockFetch(120, { incidents: [] }) as never;
    const res = await POST(request(baseBody()));
    const body = (await res.json()) as {
      traffic: { status: string; items: unknown[]; call: { decision: string } };
      avoidCircles: unknown[];
    };
    expect(body.traffic.status).toBe("ok");
    expect(body.traffic.items).toEqual([]);
    expect(body.traffic.call.decision).toBe("none");
    expect(body.avoidCircles).toEqual([]);
  });

  it("is unavailable when the TomTom key is missing — never invented traffic", async () => {
    delete process.env.TOMTOM_API_KEY;
    global.fetch = mockFetch(120, tomtomBody()) as never;
    const res = await POST(request(baseBody()));
    const body = (await res.json()) as {
      traffic: { status: string; items: unknown[]; notes: string[] };
    };
    expect(body.traffic.status).toBe("unavailable");
    expect(body.traffic.items).toEqual([]);
    expect(body.traffic.notes[0]).toContain("isn't set up yet");
  });

  it("rejects a one-point geometry with a 400", async () => {
    global.fetch = mockFetch(120, tomtomBody()) as never;
    const res = await POST(request({ ...baseBody(), geometry: [GEOMETRY[0]] }));
    expect(res.status).toBe(400);
  });
});
