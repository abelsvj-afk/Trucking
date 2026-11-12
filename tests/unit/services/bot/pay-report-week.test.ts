// Defect 2026-11-12: Abel's weekly pay report chose its week on the UTC
// calendar. On Sunday evening Eastern (already Monday in UTC) "this week"
// became the week that had not started for the driver. The week is now the
// owner's calendar week (America/New_York), Monday to Sunday.

import { describe, expect, it } from "vitest";
import { lastCompletedWeekStart, mondayOf } from "@/services/bot/pay-report";

/** The old rule, kept here only to prove the defect. */
function utcMondayOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// Sunday Nov 15 2026, 8:30 PM Eastern (EST, UTC-5) = Monday Nov 16 01:30 UTC.
const SUNDAY_EVENING_EST = new Date("2026-11-16T01:30:00Z");
// Sunday Jul 12 2026, 8:30 PM Eastern (EDT, UTC-4) = Monday Jul 13 00:30 UTC.
const SUNDAY_EVENING_EDT = new Date("2026-07-13T00:30:00Z");

describe("the defect, reproduced", () => {
  it("the UTC rule puts Sunday evening Eastern into next week", () => {
    expect(utcMondayOf(SUNDAY_EVENING_EST)).toBe("2026-11-16");
    expect(utcMondayOf(SUNDAY_EVENING_EDT)).toBe("2026-07-13");
  });
});

describe("mondayOf - the owner's calendar week", () => {
  it("Sunday evening Eastern still belongs to the week that is ending (winter and summer time)", () => {
    expect(mondayOf(SUNDAY_EVENING_EST)).toBe("2026-11-09");
    expect(mondayOf(SUNDAY_EVENING_EDT)).toBe("2026-07-06");
  });

  it("the week turns at midnight Eastern, not at midnight UTC", () => {
    expect(mondayOf(new Date("2026-11-16T04:59:00Z"))).toBe("2026-11-09"); // Sun 11:59 PM EST
    expect(mondayOf(new Date("2026-11-16T05:00:00Z"))).toBe("2026-11-16"); // Mon 12:00 AM EST
  });

  it("agrees with the old rule everywhere outside that Sunday-evening window", () => {
    for (const iso of ["2026-11-09T05:00:00Z", "2026-11-11T17:00:00Z", "2026-11-14T03:00:00Z", "2026-11-15T23:59:00Z"]) {
      expect(mondayOf(new Date(iso))).toBe("2026-11-09");
    }
    expect(mondayOf(new Date("2026-11-11T17:00:00Z"))).toBe(utcMondayOf(new Date("2026-11-11T17:00:00Z")));
  });

  it("handles the daylight-saving weekends and a year boundary", () => {
    expect(mondayOf(new Date("2026-03-08T12:00:00Z"))).toBe("2026-03-02"); // spring-forward Sunday
    expect(mondayOf(new Date("2026-11-01T12:00:00Z"))).toBe("2026-10-26"); // fall-back Sunday
    expect(mondayOf(new Date("2027-01-01T17:00:00Z"))).toBe("2026-12-28"); // Friday Jan 1
  });
});

describe("lastCompletedWeekStart - the scheduled report's week", () => {
  it("on Sunday evening Eastern the week just ended is the PREVIOUS one: Sunday is not over", () => {
    expect(lastCompletedWeekStart(SUNDAY_EVENING_EST)).toBe("2026-11-02");
  });

  it("from Monday midnight Eastern it is the week that just ended", () => {
    expect(lastCompletedWeekStart(new Date("2026-11-16T05:00:00Z"))).toBe("2026-11-09");
    expect(lastCompletedWeekStart(new Date("2026-11-16T14:00:00Z"))).toBe("2026-11-09");
  });
});
