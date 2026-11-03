// Reliability Unit B (design B.2.4/B.2.5): carrier-anchored period
// math. All expected values are hand-derived from the zone rules:
// America/New_York is EST (UTC-5) in January; America/Chicago is CST
// (UTC-6). DST spring-forward 2026: Mar 8, 2:00 AM local.

import { describe, expect, it } from "vitest";
import {
  cycleLimitMinutes,
  cyclePeriodCount,
  hosCalculationWindowStartMs,
  hosPeriodStartMs,
  normalizeHosCarrierConfig,
  shiftHosPeriodStartMs,
  type HosCarrierConfig,
} from "@/lib/hos-periods";

const NY_0600: HosCarrierConfig = {
  cycle: "70/8",
  periodAnchor: "06:00",
  restartEnabled: true,
  carrierTimeZone: "America/New_York",
};
const NY_0000: HosCarrierConfig = { ...NY_0600, periodAnchor: "00:00" };

describe("hosPeriodStartMs", () => {
  it("anchor 06:00: an instant after the anchor starts today's period", () => {
    // Jan 15, 07:00 EST = 12:00Z. Period began 06:00 EST = 11:00Z.
    expect(hosPeriodStartMs(Date.parse("2026-01-15T12:00:00Z"), NY_0600)).toBe(
      Date.parse("2026-01-15T11:00:00Z"),
    );
  });

  it("anchor 06:00: an instant before the anchor belongs to yesterday's period", () => {
    // Jan 15, 05:00 EST = 10:00Z. Period began Jan 14, 06:00 EST.
    expect(hosPeriodStartMs(Date.parse("2026-01-15T10:00:00Z"), NY_0600)).toBe(
      Date.parse("2026-01-14T11:00:00Z"),
    );
  });

  it("anchor 00:00: the period is the carrier-zone calendar day", () => {
    // Jan 14, 23:00 EST = Jan 15 04:00Z. Day began Jan 14 00:00 EST.
    expect(hosPeriodStartMs(Date.parse("2026-01-15T04:00:00Z"), NY_0000)).toBe(
      Date.parse("2026-01-14T05:00:00Z"),
    );
  });

  it("an instant exactly on the anchor starts a new period", () => {
    expect(hosPeriodStartMs(Date.parse("2026-01-15T11:00:00Z"), NY_0600)).toBe(
      Date.parse("2026-01-15T11:00:00Z"),
    );
  });

  it("the carrier zone governs: the same instant has different period starts per zone", () => {
    const instant = Date.parse("2026-01-15T11:30:00Z"); // 06:30 EST / 05:30 CST
    const chicago: HosCarrierConfig = { ...NY_0600, carrierTimeZone: "America/Chicago" };
    expect(hosPeriodStartMs(instant, NY_0600)).toBe(Date.parse("2026-01-15T11:00:00Z"));
    // In Chicago the 06:00 anchor has not happened yet today (05:30
    // local), so the period began yesterday 06:00 CST = 12:00Z Jan 14.
    expect(hosPeriodStartMs(instant, chicago)).toBe(Date.parse("2026-01-14T12:00:00Z"));
  });

  it("DST spring-forward: the Mar 8 period starts 06:00 EDT and the prior period spans 23h", () => {
    // Mar 8 2026, 11:00 EDT = 15:00Z. Period began 06:00 EDT = 10:00Z.
    const start = hosPeriodStartMs(Date.parse("2026-03-08T15:00:00Z"), NY_0600);
    expect(start).toBe(Date.parse("2026-03-08T10:00:00Z"));
    const previous = shiftHosPeriodStartMs(start, -1, NY_0600);
    expect(previous).toBe(Date.parse("2026-03-07T11:00:00Z")); // Mar 7, 06:00 EST
    expect(start - previous).toBe(23 * 60 * 60 * 1000);
  });
});

describe("shiftHosPeriodStartMs / hosCalculationWindowStartMs (B.2.4)", () => {
  it("shifts by whole periods along local dates", () => {
    const start = Date.parse("2026-01-15T11:00:00Z");
    expect(shiftHosPeriodStartMs(start, -10, NY_0600)).toBe(Date.parse("2026-01-05T11:00:00Z"));
    expect(shiftHosPeriodStartMs(start, 2, NY_0600)).toBe(Date.parse("2026-01-17T11:00:00Z"));
  });

  it("70/8 window opens (8 + 2) = 10 periods before the current period", () => {
    const now = Date.parse("2026-01-15T20:00:00Z"); // current period: Jan 15 06:00 EST
    expect(hosCalculationWindowStartMs(now, NY_0600)).toBe(Date.parse("2026-01-05T11:00:00Z"));
  });

  it("60/7 window opens (7 + 2) = 9 periods before the current period", () => {
    const now = Date.parse("2026-01-15T20:00:00Z");
    expect(hosCalculationWindowStartMs(now, { ...NY_0600, cycle: "60/7" })).toBe(
      Date.parse("2026-01-06T11:00:00Z"),
    );
  });
});

describe("cycle helpers + config normalization", () => {
  it("cycle period counts and limits", () => {
    expect(cyclePeriodCount("70/8")).toBe(8);
    expect(cyclePeriodCount("60/7")).toBe(7);
    expect(cycleLimitMinutes("70/8")).toBe(4200);
    expect(cycleLimitMinutes("60/7")).toBe(3600);
  });

  it("normalizeHosCarrierConfig substitutes provisional defaults for invalid fields", () => {
    expect(normalizeHosCarrierConfig({})).toEqual({
      cycle: "70/8",
      periodAnchor: "00:00",
      restartEnabled: true,
      carrierTimeZone: "America/New_York",
    });
    expect(
      normalizeHosCarrierConfig({
        cycle: "weekly",
        periodAnchor: "25:99",
        restartEnabled: "yes",
        carrierTimeZone: "Bogus/Zone",
      }),
    ).toEqual({
      cycle: "70/8",
      periodAnchor: "00:00",
      restartEnabled: true,
      carrierTimeZone: "America/New_York",
    });
    expect(
      normalizeHosCarrierConfig({
        cycle: "60/7",
        periodAnchor: "06:00",
        restartEnabled: false,
        carrierTimeZone: "America/Chicago",
      }),
    ).toEqual({
      cycle: "60/7",
      periodAnchor: "06:00",
      restartEnabled: false,
      carrierTimeZone: "America/Chicago",
    });
  });
});
