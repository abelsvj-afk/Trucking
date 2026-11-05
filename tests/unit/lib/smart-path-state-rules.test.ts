import { describe, expect, it } from "vitest";
import { stateRuleLines } from "@/lib/smart-path-state-rules";
import { STATE_TRUCK_RULES } from "@/data/state-truck-rules";

const NOW = new Date("2026-11-05T12:00:00Z");
const rule = { state: "XX", summary: "Posted height limit applies.", limit: { kind: "height_in" as const, max: 162 }, source_url: "https://example.gov/rule", verified_on: "2026-09-01" };

describe("stateRuleLines", () => {
  it("never says a state has no restriction - it says no rule is on file", () => {
    const l = stateRuleLines(["FL"], [], null, NOW);
    expect(l[0]!.kind).toBe("no_rule_on_file");
    expect(l[0]!.text).toContain("no truck rule on file");
  });
  it("warns only when his truck profile exceeds the limit", () => {
    expect(stateRuleLines(["XX"], [rule], { height_in: 165, length_in: null, weight_lbs: null }, NOW)[0]!.kind).toBe("exceeds");
    expect(stateRuleLines(["XX"], [rule], { height_in: 160, length_in: null, weight_lbs: null }, NOW)[0]!.kind).toBe("info");
    expect(stateRuleLines(["XX"], [rule], null, NOW)[0]!.kind).toBe("info");
  });
  it("shows the age of an old row", () => {
    const l = stateRuleLines(["XX"], [{ ...rule, verified_on: "2025-01-10" }], null, NOW)[0]!;
    expect(l.old).toBe(true);
    expect(l.text).toContain("last verified 2025-01-10");
  });
  it("lists each crossed state once", () => {
    expect(stateRuleLines(["FL", "FL", "GA"], [], null, NOW)).toHaveLength(2);
  });
  it("the shipped table contains only dated, sourced rows", () => {
    for (const r of STATE_TRUCK_RULES) {
      expect(r.source_url).toMatch(/^https:\/\//);
      expect(r.verified_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
