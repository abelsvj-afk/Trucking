import { describe, expect, it } from "vitest";
import { formatSinceTime } from "@/lib/time";
import { isProvisionalCarrierConfig, PERIOD_ANCHOR_PATTERN } from "@/lib/hos-periods";
import { PROVISIONAL_HOS_CONFIG } from "@/lib/hos-cycle";

const NY = "America/New_York";

describe("formatSinceTime (visual audit F5)", () => {
  // now = Nov 4, 2026 10:00 AM New York (15:00Z)
  const now = Date.parse("2026-11-04T15:00:00Z");

  it("same calendar day in the zone: just the time", () => {
    expect(formatSinceTime("2026-11-04T13:34:00Z", now, NY)).toBe("8:34 AM");
  });

  it("yesterday: the date comes with it, so 'since 12:34 PM' can't read as today", () => {
    expect(formatSinceTime("2026-11-03T17:34:00Z", now, NY)).toBe("Nov 3, 2026, 12:34 PM");
  });

  it("uses the zone's calendar, not UTC's (11 PM last night is yesterday, though it's already tomorrow in UTC)", () => {
    // Nov 3, 11:00 PM EST = Nov 4, 04:00Z
    expect(formatSinceTime("2026-11-04T04:00:00Z", now, NY)).toBe("Nov 3, 2026, 11:00 PM");
  });

  it("an unparseable value comes back as written rather than throwing", () => {
    expect(formatSinceTime("not a time", now, NY)).toBe("not a time");
  });
});

describe("isProvisionalCarrierConfig", () => {
  it("is true only while every field is still the provisional default", () => {
    expect(isProvisionalCarrierConfig(PROVISIONAL_HOS_CONFIG)).toBe(true);
    expect(isProvisionalCarrierConfig({ ...PROVISIONAL_HOS_CONFIG, cycle: "60/7" })).toBe(false);
    expect(isProvisionalCarrierConfig({ ...PROVISIONAL_HOS_CONFIG, periodAnchor: "06:00" })).toBe(false);
    expect(isProvisionalCarrierConfig({ ...PROVISIONAL_HOS_CONFIG, restartEnabled: false })).toBe(false);
    expect(isProvisionalCarrierConfig({ ...PROVISIONAL_HOS_CONFIG, carrierTimeZone: "America/Chicago" })).toBe(false);
    expect(PERIOD_ANCHOR_PATTERN.test(PROVISIONAL_HOS_CONFIG.periodAnchor)).toBe(true);
  });
});
