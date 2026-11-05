import { describe, expect, it } from "vitest";
import { buildRoadWorkSection } from "@/services/smart-path/route-roadwork";
import { parseWzdx, roadWorkItems } from "@/lib/smart-path-roadwork";

const corridor = [
  { mile: 0, lat: 30, lng: -90, etaAt: "2026-11-06T12:00:00Z" },
  { mile: 100, lat: 31.4, lng: -90, etaAt: "2026-11-06T14:00:00Z" },
];
const feature = (lat: number, o: Record<string, unknown> = {}) => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates: [[-90, lat], [-90, lat + 0.01]] },
  properties: { core_details: { event_type: "work-zone", road_names: ["I-10"], direction: "eastbound", description: "Paving" }, start_date: "2026-11-01T00:00:00Z", end_date: "2026-11-30T00:00:00Z", vehicle_impact: "some-lanes-closed", ...o },
});
const feed = (...f: unknown[]) => ({ type: "FeatureCollection", features: f });

describe("parseWzdx", () => {
  it("rejects a non-feed and skips unreadable features, counting them", () => {
    expect(() => parseWzdx({ nope: 1 })).toThrow();
    const r = parseWzdx(feed(feature(31.4), { garbage: true }));
    expect(r.events).toHaveLength(1);
    expect(r.skipped).toBe(1);
  });
});

describe("roadWorkItems", () => {
  it("keeps events near the route and active at his arrival, drops far or ended ones", () => {
    const { events } = parseWzdx(feed(feature(31.4), feature(35), feature(31.4, { end_date: "2026-11-06T13:00:00Z" })));
    const items = roadWorkItems(events, corridor, null);
    expect(items).toHaveLength(1);
    expect(items[0]!.mile).toBe(100);
  });
  it("warns when a posted height limit is under his truck", () => {
    const { events } = parseWzdx(feed(feature(31.4, { restrictions: [{ type: "reduced-height", value: 13, unit: "foot" }] })));
    expect(roadWorkItems(events, corridor, 162)[0]!.exceedsTruck).toBe(true); // 13 ft = 156 in
    expect(roadWorkItems(events, corridor, 150)[0]!.exceedsTruck).toBe(false);
  });
});

describe("buildRoadWorkSection", () => {
  const NOW = new Date("2026-11-06T10:00:00Z");
  it("names a state with no feed and never calls it clear", async () => {
    const s = await buildRoadWorkSection(["LA"], corridor, null, { feeds: [], now: NOW });
    expect(s.status).toBe("unavailable");
    expect(s.notes[0]).toContain("No work-zone data for LA");
  });
  it("reports a down feed as unknown", async () => {
    const s = await buildRoadWorkSection(["LA"], corridor, null, { feeds: [{ state: "LA", url: "https://x.gov/f", verifiedBy: "t" }], fetcher: async () => { throw new Error("answered HTTP 503"); }, now: NOW });
    expect(s.status).toBe("unavailable");
    expect(s.notes[0]).toContain("road work there is unknown");
  });
  it("returns items from a good feed and is partial when another state has none", async () => {
    const s = await buildRoadWorkSection(["LA", "MS"], corridor, null, { feeds: [{ state: "LA", url: "https://x.gov/f", verifiedBy: "t" }], fetcher: async () => feed(feature(31.4)), now: NOW });
    expect(s.status).toBe("partial");
    expect(s.items).toHaveLength(1);
  });
});
