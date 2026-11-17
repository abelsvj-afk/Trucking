import { describe, expect, it } from "vitest";
import { buildBridgesSection } from "@/services/smart-path/route-bridges";

const CORRIDOR = [
  { mile: 0, lat: 35, lng: -90, etaAt: "2026-11-17T12:00:00-06:00" },
  { mile: 50, lat: 35.72, lng: -90, etaAt: "2026-11-17T13:00:00-06:00" },
  { mile: 100, lat: 36.45, lng: -90, etaAt: "2026-11-17T14:00:00-06:00" },
];

describe("buildBridgesSection", () => {
  it("builds bridge items against his truck height", async () => {
    const section = await buildBridgesSection({
      corridor: CORRIDOR,
      truckHeightIn: 162,
      fetchers: {
        features: async () => [
          { id: "way/1", point: { lat: 35.7, lng: -90 }, maxHeightIn: 160, name: null, road: "I-55" },
        ],
      },
      now: new Date("2026-11-17T12:00:00-06:00"),
    });
    expect(section.status).toBe("ok");
    expect(section.items).toHaveLength(1);
    expect(section.items[0]!.clearance).toBe("below");
    expect(section.notes.join(" ")).toContain("no posted clearance");
  });
  it("is ok with no bridges, and says so", async () => {
    const section = await buildBridgesSection({
      corridor: CORRIDOR,
      truckHeightIn: 162,
      fetchers: { features: async () => [] },
      now: new Date("2026-11-17T12:00:00-06:00"),
    });
    expect(section.status).toBe("ok");
    expect(section.items).toEqual([]);
    expect(section.notes[0]).toContain("none found");
  });
  it("warns when his truck height is unknown", async () => {
    const section = await buildBridgesSection({
      corridor: CORRIDOR,
      truckHeightIn: null,
      fetchers: { features: async () => [] },
      now: new Date("2026-11-17T12:00:00-06:00"),
    });
    expect(section.notes.join(" ")).toContain("truck height isn't in the app");
  });
  it("is unavailable when the provider fails, never a guessed clearance", async () => {
    const section = await buildBridgesSection({
      corridor: CORRIDOR,
      truckHeightIn: 162,
      fetchers: { features: async () => { throw new Error("down"); } },
      now: new Date("2026-11-17T12:00:00-06:00"),
    });
    expect(section.status).toBe("unavailable");
    expect(section.items).toEqual([]);
    expect(section.notes[0]).toContain("couldn't be checked");
  });
});
