import { describe, expect, it } from "vitest";
import { ASSUMED_AVG_MPH, loadHosCost, type HosGlance } from "@/lib/hos-cost";

const H = 3_600_000;
const glance = (over: Partial<HosGlance> = {}): HosGlance => ({
  driveLeftMs: 6 * H, windowLeftMs: 8 * H, breakDueInMs: 4 * H, cycleLeftMs: 40 * H, cycleLabel: "70/8", rested: false, ...over,
});

describe("loadHosCost", () => {
  it("no mileage: says it can't estimate (never a made-up number)", () => {
    expect(loadHosCost(null, glance())).toMatchObject({ driveHours: null, fitsToday: null });
  });
  it("a load that fits today's drive time, and what it uses of the cycle", () => {
    const c = loadHosCost(250, glance()); // 5h at 50 mph
    expect(c.driveHours).toBe(250 / ASSUMED_AVG_MPH);
    expect(c.fitsToday).toBe(true);
    expect(c.text).toMatch(/fits in the 6h 00m/);
    expect(c.text).toMatch(/Uses about 5h 00m of your 70\/8; 35h 00m would be left/);
    expect(c.text).toMatch(/not an ELD/);
  });
  it("a long load needs resets beyond what's left today; 1,000 miles = 20 h", () => {
    const c = loadHosCost(1000, glance());
    expect(c.fitsToday).toBe(false);
    expect(c.extraResets).toBe(2); // 20h - 6h left = 14h overflow -> 2 resets of 11h
    expect(c.text).toMatch(/needs 2 more 10-hour resets/);
  });
  it("rested: drive time counts from a full 11 h", () => {
    const c = loadHosCost(500, glance({ rested: true, driveLeftMs: 0 })); // 10 h
    expect(c.fitsToday).toBe(true);
    expect(c.text).toMatch(/after your reset/);
  });
  it("more driving than the cycle has left: says a restart is needed", () => {
    expect(loadHosCost(1000, glance({ cycleLeftMs: 10 * H })).text).toMatch(/34-hour restart/);
  });
  it("break comes due partway", () => {
    expect(loadHosCost(250, glance({ breakDueInMs: 2 * H })).text).toMatch(/30-minute break comes due after 2h 00m/);
  });
  it("no clocks available: states the hours but not the fit", () => {
    const c = loadHosCost(250, null);
    expect(c.fitsToday).toBeNull();
    expect(c.text).toMatch(/clocks aren't available/);
  });
});
