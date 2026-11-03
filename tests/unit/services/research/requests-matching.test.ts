// UH-03 regression tests (union fix round): R-6 matching writer.
import { describe, expect, it } from "vitest";
import { pretripRequestMatches } from "@/services/research/requests";
import type { ResearchRequestRow } from "@/services/research/requests";

const ask = (over: Partial<ResearchRequestRow>): ResearchRequestRow => ({
  id: "r1", company_id: "c1", load_id: null, kind: "pretrip_photo",
  detail: { items: ["tires"] }, status: "queued",
  created_at: "2026-11-02T07:00:00Z", fulfilled_at: null, ...over,
});

describe("UH-03: pretripRequestMatches", () => {
  it("tire photo does not match a BOL-only ask for another load (hunt proof, inverted)", () => {
    const a = ask({ load_id: "99999999-9999-4999-8999-999999999999", detail: { items: ["BOL"] } });
    expect(pretripRequestMatches(a, { evidenceText: "steer tire, tread looks fine", loadId: null })).toBe(false);
  });
  it("one item's photo does not match a four-item ask", () => {
    const a = ask({ detail: { items: ["tires", "lights", "load securement", "BOL"] } });
    expect(pretripRequestMatches(a, { evidenceText: "tire", loadId: null })).toBe(false);
  });
  it("matching load + full coverage matches", () => {
    const a = ask({ load_id: "L1", detail: { items: ["tires", "BOL"] } });
    expect(pretripRequestMatches(a, { evidenceText: "tire and BOL bill of lading", loadId: "L1" })).toBe(true);
    expect(pretripRequestMatches(a, { evidenceText: "tire and BOL bill of lading", loadId: "L2" })).toBe(false);
  });
});
