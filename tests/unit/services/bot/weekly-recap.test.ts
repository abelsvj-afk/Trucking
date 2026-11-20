// Sunday money recap (owner 2026-11-17). Fictional figures.
import { describe, expect, it } from "vitest";
import { composeRecap, recapDue } from "@/services/bot/weekly-recap";

const ET = "America/New_York";

describe("Sunday money recap", () => {
  it("due Sunday 5-9 PM on his clock, for the Monday-Sunday week", () => {
    expect(recapDue(Date.parse("2026-11-22T22:30:00Z"), ET)).toEqual({ weekStart: "2026-11-16", weekEnd: "2026-11-22" }); // Sun 5:30 PM ET
    expect(recapDue(Date.parse("2026-11-22T20:00:00Z"), ET)).toBeNull(); // Sun 3 PM
    expect(recapDue(Date.parse("2026-11-23T02:30:00Z"), ET)).toBeNull(); // Sun 9:30 PM - quiet hours
    expect(recapDue(Date.parse("2026-11-21T23:00:00Z"), ET)).toBeNull(); // Saturday
  });

  it("miles, pay, fuel, expenses and cost per mile, from his records", () => {
    const text = composeRecap({ weekStart: "2026-11-16", weekEnd: "2026-11-22", loads: 3, miles: 2400, payLowCents: 132000, payHighCents: 132000, unpriced: 0, fuelCents: 96000, expensesCents: 24000 });
    expect(text).toContain("3 loads delivered · 2,400 mi");
    expect(text).toContain("Pay from them: $1,320.00");
    expect(text).toContain("Fuel: $960.00 · Other expenses: $240.00");
    expect(text).toContain("Cost per mile: $0.50");
    expect(text).toContain("Pay per mile: $0.55");
  });

  it("no miles: says it can't work out cost per mile instead of dividing by zero", () => {
    const text = composeRecap({ weekStart: "2026-11-16", weekEnd: "2026-11-22", loads: 0, miles: 0, payLowCents: 0, payHighCents: 0, unpriced: 0, fuelCents: 5000, expensesCents: 0 });
    expect(text).toContain("can't work it out");
    expect(text).not.toContain("Pay per mile");
  });

  // Audit F-004: a failed read is said, never shown as $0.
  it("a failed fuel or expenses read says so — never $0 — and skips cost per mile", () => {
    const text = composeRecap({ weekStart: "2026-11-16", weekEnd: "2026-11-22", loads: 2, miles: 1000, payLowCents: 60000, payHighCents: 60000, unpriced: 0, fuelCents: null, expensesCents: 1000 });
    expect(text).toContain("Fuel: couldn't read fuel this week");
    expect(text).not.toContain("Fuel: $0.00");
    expect(text).toContain("won't guess");
    expect(text).not.toMatch(/Cost per mile: \$/);
  });
});
