import { describe, expect, it } from "vitest";
import { addDays, zonedDate, zonedDayBounds, zonedInstant } from "@/lib/zoned-day";

const NY = "America/New_York";

describe("zoned-day", () => {
  it("places a wall time on the carrier's clock (EST and EDT)", () => {
    expect(zonedInstant("2026-11-03", "00:00", NY).toISOString()).toBe("2026-11-03T05:00:00.000Z");
    expect(zonedInstant("2026-07-01", "08:30", NY).toISOString()).toBe("2026-07-01T12:30:00.000Z");
  });
  it("handles 24:00 as the next midnight", () => {
    expect(zonedInstant("2026-11-03", "24:00", NY).toISOString()).toBe("2026-11-04T05:00:00.000Z");
  });
  it("gets daylight-saving changeover days right (23h and 25h days)", () => {
    const spring = zonedDayBounds("2026-03-08", NY);
    expect((spring.endMs - spring.startMs) / 3_600_000).toBe(23);
    const fall = zonedDayBounds("2026-11-01", NY);
    expect((fall.endMs - fall.startMs) / 3_600_000).toBe(25);
    // 04:00 on the spring-forward day is EDT (UTC-4)
    expect(zonedInstant("2026-03-08", "04:00", NY).toISOString()).toBe("2026-03-08T08:00:00.000Z");
    // 03:00 on the fall-back day is EST (UTC-5)
    expect(zonedInstant("2026-11-01", "03:00", NY).toISOString()).toBe("2026-11-01T08:00:00.000Z");
  });
  it("reads an instant's date on the carrier's calendar, not UTC's", () => {
    // 2026-11-04 03:00Z is still Nov 3 in New York
    expect(zonedDate(Date.parse("2026-11-04T03:00:00Z"), NY)).toBe("2026-11-03");
  });
  it("adds days across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
