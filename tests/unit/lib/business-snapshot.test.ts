// Own-business snapshot builder (docs/design/autonomous-research.md
// §3): figures come only from the input records, pay terms are read
// as data, and an unset basis is SAID - never silently picked.

import { describe, expect, it } from "vitest";
import { buildBusinessSnapshot, type BusinessSnapshotInput } from "@/lib/business-snapshot";

const BASE: BusinessSnapshotInput = {
  loadsInWindow: 4,
  loadsCompleted: 2,
  totalMiles: 3210,
  revenueCents: 410000,
  expenseCents: 62500,
  topLanes: ["Panama City, FL → Seminole, OK ×2"],
  payProfile: { rateCentsPerMile: 55, mileBasis: "all" },
  windowDays: 30,
};

describe("buildBusinessSnapshot", () => {
  it("summarizes activity, money, lanes, and pay terms from the records", () => {
    const snap = buildBusinessSnapshot(BASE);
    expect(snap).not.toBeNull();
    expect(snap!.content).toContain("4 loads");
    expect(snap!.content).toContain("2 completed");
    expect(snap!.content).toContain("3,210 miles");
    expect(snap!.content).toContain("$4,100.00");
    expect(snap!.content).toContain("$625.00");
    expect(snap!.content).toContain("Panama City, FL → Seminole, OK ×2");
    expect(snap!.content).toContain("$0.55 per mile");
    expect(snap!.content).toContain("all miles (loaded + deadhead)");
  });

  it("says UNSET when the mile basis is unset instead of picking one", () => {
    const snap = buildBusinessSnapshot({ ...BASE, payProfile: { rateCentsPerMile: 55, mileBasis: null } });
    expect(snap!.content).toContain("UNSET");
    expect(snap!.content).toContain("range");
  });

  it("claims no revenue when no load carries a rate", () => {
    const snap = buildBusinessSnapshot({ ...BASE, revenueCents: null });
    expect(snap!.content).toContain("not stated");
    expect(snap!.content).not.toContain("$0.00");
  });

  it("says no pay profile instead of inventing a rate", () => {
    const snap = buildBusinessSnapshot({ ...BASE, payProfile: null });
    expect(snap!.content).toContain("no pay profile on file");
    expect(snap!.content).not.toContain("per mile,");
  });

  it("returns null when there is nothing at all to say", () => {
    expect(
      buildBusinessSnapshot({
        loadsInWindow: 0,
        loadsCompleted: 0,
        totalMiles: 0,
        revenueCents: null,
        expenseCents: 0,
        topLanes: [],
        payProfile: null,
        windowDays: 30,
      }),
    ).toBeNull();
  });

  it("still reports a pay profile with zero activity", () => {
    const snap = buildBusinessSnapshot({ ...BASE, loadsInWindow: 0, loadsCompleted: 0, totalMiles: 0, expenseCents: 0, topLanes: [] });
    expect(snap!.content).toContain("no loads on the books");
    expect(snap!.content).toContain("$0.55 per mile");
  });
});
