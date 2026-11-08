// Audit rank 4 acceptance: daylight-saving transitions are covered, and the phone's timezone never changes what is shown or stored.
import { afterEach, describe, expect, it } from "vitest";
import { formatDate, formatDateTime } from "@/lib/time";
import { zonedDate, zonedInstant, zoneOffsetMinutes } from "@/lib/zoned-day";

const ET = "America/New_York";
const realTZ = process.env.TZ;
afterEach(() => { process.env.TZ = realTZ; });

describe("Eastern formatting does not depend on the phone's timezone", () => {
  it.each(["UTC", "Asia/Tokyo", "America/Los_Angeles", "Pacific/Auckland"])("the same instant reads the same with the runtime in %s", (tz) => {
    process.env.TZ = tz;
    expect(formatDateTime("2026-11-07T20:00:00Z", ET)).toBe("Nov 7, 2026, 3:00 PM");
    expect(formatDate("2026-11-08T03:30:00Z", ET)).toBe("Nov 7, 2026"); // late evening Eastern is still the 7th, not the UTC 8th
  });
});

describe("daylight-saving transitions (2026: spring forward Mar 8, fall back Nov 1)", () => {
  it("offsets switch on the right instants", () => {
    expect(zoneOffsetMinutes(Date.parse("2026-03-08T06:59:00Z"), ET)).toBe(-300); // 1:59 AM EST
    expect(zoneOffsetMinutes(Date.parse("2026-03-08T07:00:00Z"), ET)).toBe(-240); // 3:00 AM EDT
    expect(zoneOffsetMinutes(Date.parse("2026-11-01T05:59:00Z"), ET)).toBe(-240); // 1:59 AM EDT
    expect(zoneOffsetMinutes(Date.parse("2026-11-01T07:00:00Z"), ET)).toBe(-300); // 2:00 AM EST (after the repeated hour)
  });
  it("an appointment entered as Eastern wall time maps to the right instant on both sides of the change", () => {
    expect(zonedInstant("2026-03-07", "08:00", ET).toISOString()).toBe("2026-03-07T13:00:00.000Z"); // EST
    expect(zonedInstant("2026-03-09", "08:00", ET).toISOString()).toBe("2026-03-09T12:00:00.000Z"); // EDT
    expect(zonedInstant("2026-10-31", "08:00", ET).toISOString()).toBe("2026-10-31T12:00:00.000Z");
    expect(zonedInstant("2026-11-02", "08:00", ET).toISOString()).toBe("2026-11-02T13:00:00.000Z");
  });
  it("the Eastern calendar day of an instant never slips across midnight UTC", () => {
    expect(zonedDate(Date.parse("2026-11-08T03:59:00Z"), ET)).toBe("2026-11-07");
    expect(zonedDate(Date.parse("2026-11-08T05:00:00Z"), ET)).toBe("2026-11-08");
  });
});
