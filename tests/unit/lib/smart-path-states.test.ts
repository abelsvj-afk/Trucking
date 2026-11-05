import { describe, expect, it } from "vitest";
import { PADD_BY_STATE, stateAt, statesAlongRoute } from "@/lib/smart-path-states";
import { buildCorridor } from "@/lib/smart-path-corridor";

describe("stateAt", () => {
  it("finds well-known interior points", () => {
    expect(stateAt(30.33, -81.66)).toBe("FL"); // Jacksonville
    expect(stateAt(33.75, -84.39)).toBe("GA"); // Atlanta
    expect(stateAt(32.78, -96.8)).toBe("TX"); // Dallas
    expect(stateAt(41.88, -87.63)).toBe("IL"); // Chicago
    expect(stateAt(39.74, -104.99)).toBe("CO"); // Denver
  });
  it("is null far from any state (mid-ocean)", () => {
    expect(stateAt(30, -60)).toBeNull();
  });
});

describe("statesAlongRoute", () => {
  it("lists Jacksonville -> Atlanta -> Nashville states in order with sensible miles", () => {
    const route = [{ lat: 30.33, lng: -81.66 }, { lat: 33.75, lng: -84.39 }, { lat: 36.16, lng: -86.78 }];
    const c = buildCorridor(route, 10);
    if (!c.ok) throw new Error(c.reason);
    const stretches = statesAlongRoute(c.corridor.points);
    expect(stretches.map((s) => s.state)).toEqual(["FL", "GA", "TN"]);
    expect(stretches[0]!.enterMile).toBe(0);
    expect(stretches[stretches.length - 1]!.exitMile).toBeCloseTo(c.corridor.totalMiles, 3);
    for (let i = 1; i < stretches.length; i++) expect(stretches[i]!.enterMile).toBe(stretches[i - 1]!.exitMile);
  });
});

describe("PADD_BY_STATE", () => {
  it("covers the lower 48 plus DC, AK, HI", () => {
    expect(Object.keys(PADD_BY_STATE)).toHaveLength(51);
    expect(PADD_BY_STATE.FL!.code).toBe("R10");
    expect(PADD_BY_STATE.TX!.code).toBe("R30");
    expect(PADD_BY_STATE.CA!.code).toBe("R50");
  });
});
