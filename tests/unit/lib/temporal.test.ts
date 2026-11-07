// Owner 2026-11-07: temporal reasoning. "Today" in these tests is Saturday 2026-11-07 (the owner's clock).

import { describe, expect, it } from "vitest";
import { daysBetween, formatLong, relativeTo, resolveWhen, timeBetween, weekOf } from "@/lib/temporal";

const TODAY = "2026-11-07"; // a Saturday
const date = (phrase: string, today = TODAY) => {
  const r = resolveWhen(phrase, today);
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("fixed and relative phrases", () => {
  it.each([
    ["today", "2026-11-07"], ["tomorrow", "2026-11-08"], ["yesterday", "2026-11-06"],
    ["the day after tomorrow", "2026-11-09"], ["day before yesterday", "2026-11-05"],
    ["in 3 days", "2026-11-10"], ["3 days ago", "2026-11-04"], ["a week ago", "2026-10-31"],
    ["in two weeks", "2026-11-21"], ["10 days from now", "2026-11-17"],
    ["in 2 months", "2027-01-07"], ["3 months ago", "2026-08-07"],
  ])("%s -> %s", (phrase, iso) => expect(date(phrase).date).toBe(iso));

  it("crosses month and year boundaries", () => {
    expect(date("in 30 days").date).toBe("2026-12-07");
    expect(date("in 60 days", "2026-12-20").date).toBe("2027-02-18");
    expect(date("2 days ago", "2027-01-01").date).toBe("2026-12-30");
  });
  it("month arithmetic clamps to the last day of a shorter month and says so", () => {
    const r = date("in 1 month", "2026-01-31");
    expect(r.date).toBe("2026-02-28");
    expect(r.note).toMatch(/last day/);
  });
  it("counts from another day: '3 days after the 6th'", () => {
    expect(date("3 days after the 6th").date).toBe("2026-11-09");
    expect(date("2 days before nov 10").date).toBe("2026-11-08");
  });
  it("leap day exists in a leap year", () => {
    expect(date("in 1 day", "2028-02-28").date).toBe("2028-02-29");
  });
});

describe("weekdays", () => {
  it("'friday' is the coming one; today counts when it is that weekday", () => {
    expect(date("friday").date).toBe("2026-11-13");
    expect(date("saturday").date).toBe("2026-11-07");
    expect(date("saturday").note).toMatch(/today/);
    expect(date("sunday").date).toBe("2026-11-08");
  });
  it("'last friday' is the most recent past one, never today", () => {
    expect(date("last friday").date).toBe("2026-11-06");
    expect(date("last saturday").date).toBe("2026-10-31");
  });
  it("'next friday' is the Friday of NEXT Monday-Sunday week and names the coming one as the alternative", () => {
    const r = date("next friday");
    expect(r.date).toBe("2026-11-13"); // Sat Nov 7: next week = Nov 9-15
    const wed = date("next friday", "2026-11-04"); // Wed: coming Friday is Nov 6, next week's is Nov 13
    expect(wed.date).toBe("2026-11-13");
    expect(wed.alternative).toBe("2026-11-06");
    expect(wed.note).toMatch(/NEXT week/);
  });
});

describe("dates and days of the month", () => {
  it("ISO, US slash and month-name dates", () => {
    expect(date("2026-11-13").date).toBe("2026-11-13");
    expect(date("11/6/2026").date).toBe("2026-11-06");
    expect(date("nov 6th").date).toBe("2026-11-06");
    expect(date("November 6, 2026").date).toBe("2026-11-06");
  });
  it("'the 6th' on Nov 7 is yesterday's 6th (nearest), and the other candidate is named", () => {
    const r = date("the 6th");
    expect(r.date).toBe("2026-11-06");
    expect(r.relative).toBe("yesterday");
    expect(r.alternative).toBe("2026-12-06");
    expect(r.note).toMatch(/nearest/);
  });
  it("'the 30th' on Nov 7 picks the nearest real one; a day that doesn't exist is refused", () => {
    expect(date("the 30th").date).toBe("2026-10-30"); // 8 days back beats Nov 30's 23 days ahead
    expect(resolveWhen("feb 30", TODAY).ok).toBe(false);
    expect(resolveWhen("2026-02-29", TODAY).ok).toBe(false);
    expect(resolveWhen("13/45", TODAY).ok).toBe(false);
  });
  it("a year-less month-day uses the nearest year", () => {
    expect(date("dec 25").date).toBe("2026-12-25");
    expect(date("jan 2", "2026-12-30").date).toBe("2027-01-02");
  });
});

describe("weeks", () => {
  it("start and end of this/next/last week (Monday to Sunday)", () => {
    expect(weekOf(TODAY)).toEqual({ start: "2026-11-02", end: "2026-11-08" });
    expect(date("end of this week").date).toBe("2026-11-08");
    expect(date("start of next week").date).toBe("2026-11-09");
    expect(date("end of last week").date).toBe("2026-11-01");
  });
});

describe("unreadable input is refused, never guessed", () => {
  it.each(["", "sometime soon", "blue", "in banana days"])("%j", (phrase) => expect(resolveWhen(phrase, TODAY).ok).toBe(false));
});

describe("relationships", () => {
  it("relativeTo / daysBetween / formatLong", () => {
    expect(relativeTo(TODAY, "2026-11-13")).toBe("in 6 days");
    expect(relativeTo(TODAY, "2026-11-06")).toBe("yesterday");
    expect(relativeTo(TODAY, "2026-11-01")).toBe("6 days ago");
    expect(daysBetween("2026-11-07", "2026-12-25")).toBe(48);
    expect(formatLong("2026-11-13")).toBe("Friday, Nov 13, 2026");
  });
  it("timeBetween gives days, weeks + days and the weekdays in between", () => {
    expect(timeBetween("2026-11-06", "2026-11-23")).toEqual({ days: 17, weeks: 2, remainderDays: 3, weekdays: 11, direction: "future" });
    expect(timeBetween("2026-11-23", "2026-11-06")).toMatchObject({ days: -17, direction: "past", weekdays: 11 });
    expect(timeBetween("2026-11-07", "2026-11-07")).toMatchObject({ days: 0, direction: "same", weekdays: 0 });
  });
  it("is stable across a daylight-saving change (calendar days, not hours)", () => {
    expect(daysBetween("2026-11-01", "2026-11-02")).toBe(1); // DST ends Nov 1 2026
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2); // DST starts Mar 8 2026
  });
});
