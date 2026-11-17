import { describe, expect, it } from "vitest";
import { buildTrafficSection } from "@/services/smart-path/route-traffic";
import type { TrafficIncident } from "@/lib/smart-path-traffic";

// Straight route north, 100 miles.
const GEOMETRY = Array.from({ length: 101 }, (_, i) => ({ lat: 35 + i * 0.01449, lng: -90 }));
const CORRIDOR = [
  { mile: 0, etaAt: "2026-11-17T12:00:00-06:00" },
  { mile: 50, etaAt: "2026-11-17T13:00:00-06:00" },
  { mile: 100, etaAt: "2026-11-17T14:00:00-06:00" },
];

const INCIDENT: TrafficIncident = {
  id: "inc-1",
  iconCategory: 6,
  description: "Queue",
  points: [{ lat: 35 + 40 * 0.01449, lng: -90 }],
  delaySeconds: 1800,
  magnitude: 3,
  startTime: null,
  endTime: "2026-11-17T14:00:00-06:00",
  from: "A",
  to: "B",
  lengthMeters: 4000,
  roadNumbers: ["I-55"],
};

describe("buildTrafficSection", () => {
  it("builds items, segments and a reroute call from live incidents", async () => {
    const section = await buildTrafficSection({
      geometry: GEOMETRY,
      totalMiles: 100,
      corridor: CORRIDOR,
      currentMile: 0,
      detour: { durationMinutes: 135, distanceMiles: 110 },
      plannedRemainingMinutes: 120,
      fetchers: { incidents: async () => [INCIDENT] },
      isConfigured: () => true,
      now: new Date("2026-11-17T12:00:00-06:00"),
    });
    expect(section.status).toBe("ok");
    expect(section.items).toHaveLength(1);
    expect(section.items[0]!.delayMinutes).toBe(30);
    expect(section.segments).toEqual([{ fromMile: expect.any(Number), toMile: expect.any(Number), color: "#dc2626" }]);
    expect(section.call.decision).toBe("reroute");
    expect(section.call.savesMinutes).toBe(15);
    expect(section.notes.join(" ")).toContain("TomTom");
    expect(section.notes.join(" ")).toContain("no reported incident");
  });
  it("is ok with no incidents, and the call is none", async () => {
    const section = await buildTrafficSection({
      geometry: GEOMETRY,
      totalMiles: 100,
      corridor: CORRIDOR,
      fetchers: { incidents: async () => [] },
      isConfigured: () => true,
      now: new Date("2026-11-17T12:00:00-06:00"),
    });
    expect(section.status).toBe("ok");
    expect(section.items).toEqual([]);
    expect(section.call.decision).toBe("none");
    expect(section.notes[0]).toContain("no reported delays");
  });
  it("is unavailable when traffic is not set up, and says so plainly", async () => {
    const section = await buildTrafficSection({
      geometry: GEOMETRY,
      totalMiles: 100,
      corridor: CORRIDOR,
      fetchers: { incidents: async () => [INCIDENT] },
      isConfigured: () => false,
      now: new Date("2026-11-17T12:00:00-06:00"),
    });
    expect(section.status).toBe("unavailable");
    expect(section.items).toEqual([]);
    expect(section.notes[0]).toContain("isn't set up yet");
    expect(section.notes[0]).toContain("TOMTOM_API_KEY");
  });
  it("is unavailable when the provider fails, never invented traffic", async () => {
    const section = await buildTrafficSection({
      geometry: GEOMETRY,
      totalMiles: 100,
      corridor: CORRIDOR,
      fetchers: { incidents: async () => { throw new Error("down"); } },
      isConfigured: () => true,
      now: new Date("2026-11-17T12:00:00-06:00"),
    });
    expect(section.status).toBe("unavailable");
    expect(section.items).toEqual([]);
    expect(section.notes[0]).toContain("couldn't be reached");
  });
  it("only judges incidents ahead of his current mile", async () => {
    const section = await buildTrafficSection({
      geometry: GEOMETRY,
      totalMiles: 100,
      corridor: CORRIDOR,
      currentMile: 50,
      fetchers: { incidents: async () => [INCIDENT] },
      isConfigured: () => true,
      now: new Date("2026-11-17T12:00:00-06:00"),
    });
    expect(section.items).toHaveLength(1);
    expect(section.call.decision).toBe("none");
  });
});
