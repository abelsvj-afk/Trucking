import { describe, expect, it } from "vitest";
import { clockExplainer } from "@/lib/clock-explainers";

describe("clock explainers (written for a new driver)", () => {
  it("every clock says what it is, what happens at zero, and what resets it", () => {
    for (const key of ["drive", "window", "break", "cycle"] as const) {
      const e = clockExplainer(key);
      expect(e.title.length).toBeGreaterThan(5);
      expect(e.what.length).toBeGreaterThan(30);
      expect(e.atZero).toMatch(/can't/i);
      expect(e.resets.length).toBeGreaterThan(20);
    }
  });
  it("covers the owner's required points", () => {
    expect(clockExplainer("drive").title).toContain("11");
    const w = clockExplainer("window");
    expect(w.what).toContain("ANY duty time");
    expect(w.what).toContain("never pauses");
    expect(w.resets).toContain("10 straight hours off");
    const b = clockExplainer("break");
    expect(b.what).toContain("DRIVING");
    expect(b.resets).toContain("30 straight minutes not driving");
    const c = clockExplainer("cycle", "70/8");
    expect(c.title).toBe("70-hour / 8-day cycle");
    expect(c.what).toContain("TOTAL on-duty hours");
    expect(c.atZero).toContain("old days fall off");
    expect(c.resets).toContain("34 straight hours off");
    expect(c.resets).toContain("restart");
  });
  it("follows the carrier's cycle (60/7)", () => {
    expect(clockExplainer("cycle", "60/7").title).toBe("60-hour / 7-day cycle");
  });
});
