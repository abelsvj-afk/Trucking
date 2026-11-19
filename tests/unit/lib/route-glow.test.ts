import { describe, expect, it } from "vitest";
import { GLOW_PERIOD_MS, GLOW_TICK_MS, glowPaintAt } from "@/lib/route-glow";

describe("route glow", () => {
  it("pulses: dimmest at the start of a breath, brightest halfway", () => {
    const low = glowPaintAt(0, false);
    const high = glowPaintAt(GLOW_PERIOD_MS / 2, false);
    expect(high.width).toBeGreaterThan(low.width);
    expect(high.opacity).toBeGreaterThan(low.opacity);
  });
  it("night glows wider and brighter than day", () => {
    expect(glowPaintAt(GLOW_PERIOD_MS / 2, true).width).toBeGreaterThan(glowPaintAt(GLOW_PERIOD_MS / 2, false).width);
  });
  it("reduced motion holds still but stays visible", () => {
    expect(glowPaintAt(0, false, true)).toEqual(glowPaintAt(777, false, true));
    expect(glowPaintAt(0, false, true).opacity).toBeGreaterThan(0.4);
  });
  it("updates no faster than ~8 times a second (cheap on a phone)", () => {
    expect(GLOW_TICK_MS).toBeGreaterThanOrEqual(100);
  });
});
