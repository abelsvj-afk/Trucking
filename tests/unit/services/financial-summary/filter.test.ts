// Reliability Unit C, task C1: the shared summary filter module -
// viewer-local month bounds (F-007's fix lands here) and the
// timestamptz window for fuel, computed from viewer-local midnights.

import { describe, expect, it } from "vitest";
import {
  addDays,
  classifyIncurred,
  componentWindow,
  localDateOfInstant,
  monthRangeInZone,
  zonedMidnightUtcMs,
} from "@/services/financial-summary/filter";

describe("shared summary filter module", () => {
  it("computes the viewer-local month: November 2026 in New York", () => {
    // Nov 15 2026, noon UTC = 7am EST.
    const now = Date.UTC(2026, 10, 15, 12, 0, 0);
    expect(monthRangeInZone("America/New_York", now)).toEqual({
      from: "2026-11-01",
      to: "2026-11-30",
    });
  });

  it("the month is the VIEWER's: an instant that is Nov 30 in New York is already Dec 1 in Tokyo", () => {
    // Dec 1 2026 02:00 UTC = Nov 30 21:00 EST = Dec 1 11:00 JST.
    const now = Date.UTC(2026, 11, 1, 2, 0, 0);
    expect(monthRangeInZone("America/New_York", now).from).toBe("2026-11-01");
    expect(monthRangeInZone("Asia/Tokyo", now).from).toBe("2026-12-01");
    expect(localDateOfInstant(now, "America/New_York")).toBe("2026-11-30");
    expect(localDateOfInstant(now, "Asia/Tokyo")).toBe("2026-12-01");
  });

  it("fuel window bounds are viewer-local midnights as UTC instants, across the DST fall-back", () => {
    // Midnight Nov 1 2026 in New York is still EDT (UTC-4): fall-back
    // happens at 2am that day. Midnight Dec 1 is EST (UTC-5).
    const window = componentWindow({ from: "2026-11-01", to: "2026-11-30" }, "America/New_York");
    expect(window.fromTs).toBe("2026-11-01T04:00:00.000Z");
    expect(window.toTs).toBe("2026-12-01T05:00:00.000Z");
    expect(zonedMidnightUtcMs("2026-11-01", "America/Chicago")).toBe(
      Date.parse("2026-11-01T05:00:00.000Z"),
    );
  });

  it("a purchase at 11pm viewer time on the month's last day falls inside the window; 1am on the 1st does not", () => {
    const window = componentWindow({ from: "2026-11-01", to: "2026-11-30" }, "America/New_York");
    const inside = Date.parse("2026-12-01T04:00:00.000Z"); // Nov 30 23:00 EST
    const outside = Date.parse("2026-12-01T06:00:00.000Z"); // Dec 1 01:00 EST
    expect(inside >= Date.parse(window.fromTs) && inside < Date.parse(window.toTs)).toBe(true);
    expect(outside >= Date.parse(window.fromTs) && outside < Date.parse(window.toTs)).toBe(false);
  });

  it("addDays and classifyIncurred behave at the boundaries", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    const range = { from: "2026-11-01", to: "2026-11-30" };
    expect(classifyIncurred("2026-10-31", range)).toBe("before");
    expect(classifyIncurred("2026-11-01", range)).toBe("in");
    expect(classifyIncurred("2026-11-30", range)).toBe("in");
    expect(classifyIncurred("2026-12-01", range)).toBe("after");
  });
});
