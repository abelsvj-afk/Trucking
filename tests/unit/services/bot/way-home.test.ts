// Owner 2026-11-17: once the monthly goal is covered, the way home.
import { describe, expect, it } from "vitest";
import { roughTripHome } from "@/services/bot/way-home";

describe("the rough trip home", () => {
  it("road miles = straight line x 1.2; no rest needed under 11 h of driving", () => {
    expect(roughTripHome(100)).toMatchObject({ miles: 120 });
    expect(roughTripHome(100).elapsedHours).toBeCloseTo(120 / 55);
  });
  it("adds a 10-hour rest for each extra 11-hour driving day", () => {
    const t = roughTripHome(800); // 960 mi, ~17.5 h driving -> one rest
    expect(t.miles).toBe(960);
    expect(t.elapsedHours).toBeCloseTo(960 / 55 + 10);
  });
});
