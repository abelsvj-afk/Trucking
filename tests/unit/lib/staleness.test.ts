import { describe, expect, it } from "vitest";
import { isTimeBound, stalenessNote, withAge } from "@/lib/staleness";

const NOW = new Date("2026-11-07T17:00:00Z"); // Saturday noon-ish Eastern
const at = (iso: string) => iso;

describe("stalenessNote", () => {
  it("a fresh, plain fact carries no note", () => {
    expect(stalenessNote("Steven pays on Fridays", at("2026-11-06T15:00:00Z"), NOW)).toBeNull();
    expect(stalenessNote("Steven pays on Fridays", at("2026-11-01T15:00:00Z"), NOW)).toBeNull(); // 6 days
  });
  it("an old fact always shows its date and age", () => {
    expect(stalenessNote("Steven pays on Fridays", at("2026-10-20T15:00:00Z"), NOW)).toBe("noted Oct 20, 18 days ago");
  });
  it("a time-bound fact is flagged as possibly out of date from the next day", () => {
    expect(stalenessNote("My active load is going to Tampa", at("2026-11-06T15:00:00Z"), NOW)).toBe("⚠ time-bound - noted yesterday, may be out of date");
    expect(stalenessNote("This week I'm home Thursday", at("2026-11-03T15:00:00Z"), NOW)).toBe("⚠ time-bound - noted Nov 3, 4 days ago, may be out of date");
    expect(stalenessNote("My active load is going to Tampa", at("2026-11-07T15:00:00Z"), NOW)).toBeNull(); // noted today
  });
  it("counts calendar days on his clock, not 24-hour blocks (a late-night note is 'yesterday' after midnight)", () => {
    // 11:30 PM Eastern Nov 6 = 04:30Z Nov 7; "now" is Nov 7 7 AM Eastern
    expect(stalenessNote("Currently waiting on a rate con", "2026-11-07T04:30:00Z", new Date("2026-11-07T12:00:00Z"))).toMatch(/noted yesterday/);
  });
  it("ignores a missing or unreadable date and a future date", () => {
    expect(stalenessNote("x", "nonsense", NOW)).toBeNull();
    expect(stalenessNote("currently x", "2026-12-01T00:00:00Z", NOW)).toBeNull();
  });
  it("isTimeBound spots time words and ignores durable ones", () => {
    for (const t of ["pays this week", "currently in Ohio", "tomorrow's pickup", "the active load"]) expect(isTimeBound(t)).toBe(true);
    for (const t of ["pays every Friday", "prefers email", "owns a 2019 Freightliner"]) expect(isTimeBound(t)).toBe(false);
  });
  it("withAge appends the note in parentheses, or leaves the text alone", () => {
    expect(withAge("Steven pays on Fridays", "2026-10-20T15:00:00Z", NOW)).toBe("Steven pays on Fridays (noted Oct 20, 18 days ago)");
    expect(withAge("Steven pays on Fridays", "2026-11-06T15:00:00Z", NOW)).toBe("Steven pays on Fridays");
    expect(withAge("Steven pays on Fridays", undefined, NOW)).toBe("Steven pays on Fridays");
  });
});
