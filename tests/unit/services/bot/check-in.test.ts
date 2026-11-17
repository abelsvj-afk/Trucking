// Abel's daily check-in (docs/design/abel-do-what-i-ask.md section 6). Fictional data.
import { describe, expect, it } from "vitest";
import { composeCheckIn, drivingTodayMs, dueCheckIn, type DutyRow } from "@/services/bot/check-in";

const ET = "America/New_York";
const at = (iso: string) => Date.parse(iso);
const row = (s: DutyRow["duty_status"], iso: string): DutyRow => ({ duty_status: s, started_at: iso });

describe("when a check-in is due (his clock)", () => {
  const night = [row("off_duty", "2026-11-15T23:00:00Z")]; // 6 PM ET the evening before

  it("morning: when he starts his day, else at 9 AM", () => {
    const started = [...night, row("on_duty", "2026-11-16T11:30:00Z")]; // 6:30 AM ET
    expect(dueCheckIn(started, at("2026-11-16T11:45:00Z"), ET)).toEqual({ kind: "morning", day: "2026-11-16" });
    expect(dueCheckIn(night, at("2026-11-16T12:00:00Z"), ET)).toBeNull(); // 7 AM ET, not started
    expect(dueCheckIn(night, at("2026-11-16T14:05:00Z"), ET)).toEqual({ kind: "morning", day: "2026-11-16" }); // 9:05 AM
  });

  it("evening: 30 minutes off after working, between 5 and 9 PM", () => {
    const day = [...night, row("driving", "2026-11-16T12:00:00Z"), row("off_duty", "2026-11-16T22:00:00Z")]; // off at 5 PM ET
    expect(dueCheckIn(day, at("2026-11-16T22:15:00Z"), ET)).toBeNull(); // only 15 min off
    expect(dueCheckIn(day, at("2026-11-16T22:40:00Z"), ET)).toEqual({ kind: "evening", day: "2026-11-16" });
    expect(dueCheckIn(day, at("2026-11-17T02:30:00Z"), ET)).toBeNull(); // 9:30 PM: quiet hours, skipped
  });

  it("no evening while he is still driving", () => {
    const driving = [...night, row("driving", "2026-11-16T20:00:00Z")];
    expect(dueCheckIn(driving, at("2026-11-16T23:00:00Z"), ET)).toBeNull();
  });
});

describe("the message", () => {
  it("driving today counts only today's part, on his clock", () => {
    const rows = [row("driving", "2026-11-16T03:00:00Z"), row("off_duty", "2026-11-16T07:00:00Z")]; // 10 PM-2 AM ET across midnight
    expect(drivingTodayMs(rows, at("2026-11-16T20:00:00Z"), ET)).toBe(2 * 3_600_000);
  });

  it("morning lists hours, load, pay, waiting - and says planning only", () => {
    const text = composeCheckIn({
      kind: "morning",
      clocks: {
        state: "ready", status: "on_duty", statusSinceMs: 0, rested: true, cycleUnavailable: false,
        clocks: [
          { key: "drive", label: "Drive", remainingMs: 11 * 3_600_000, totalMs: 0, tone: "ok" },
          { key: "window", label: "Window", remainingMs: 14 * 3_600_000, totalMs: 0, tone: "ok" },
          { key: "cycle", label: "70/8", remainingMs: 32.5 * 3_600_000, totalMs: 0, tone: "ok" },
        ],
      },
      drivingTodayMs: 0,
      nextLoad: { tripNumber: "9918", origin: "Ardmore, OK", destination: "Ocala, FL", pickupDate: "2026-11-16", deliveryDate: "2026-11-18" },
      payWeek: { lowCents: 64790, highCents: 64790 },
      waitingCount: 2,
    });
    expect(text).toContain("11h 00m driving · 14h 00m in your 14 · 32h 30m on your cycle");
    expect(text).toContain("Planning only, not an ELD");
    expect(text).toContain("Trip 9918, Ardmore, OK → Ocala, FL (pickup Mon, Nov 16, delivery Wed, Nov 18)");
    expect(text).toContain("$647.90");
    expect(text).toContain("2 things are waiting on you");
  });

  it("evening with nothing on file says so instead of guessing", () => {
    const text = composeCheckIn({ kind: "evening", clocks: null, drivingTodayMs: 5.25 * 3_600_000, nextLoad: null, payWeek: null, waitingCount: 0 });
    expect(text).toContain("Driving today: 5h 15m");
    expect(text).toContain("No upcoming load on file");
    expect(text).not.toContain("waiting");
    expect(text).not.toContain("$");
  });
});

import { yesterdayLogLine } from "@/services/bot/check-in";

describe("morning log check (owner 2026-11-17)", () => {
  it("yesterday's log on his clock, one line, with how to fix it", () => {
    const rows = [
      row("off_duty", "2026-11-16T02:00:00Z"), // Sun 9 PM ET (Sat night rest carries into Sunday... and Monday below)
      row("driving", "2026-11-16T11:40:00Z"), // Mon 6:40 AM ET
      row("on_duty", "2026-11-16T16:05:00Z"), // 11:05 AM
      row("off_duty", "2026-11-17T02:12:00Z"), // 9:12 PM
    ];
    const line = yesterdayLogLine(rows, at("2026-11-17T11:30:00Z"), ET)!; // Tue 6:30 AM ET -> yesterday = Mon Nov 16
    expect(line).toContain("Driving 6:40 AM–11:05 AM");
    expect(line).toContain("On duty 11:05 AM–9:12 PM");
    expect(line).toContain("tell me what to fix");
  });
  it("nothing logged yesterday: no line", () => {
    expect(yesterdayLogLine([], at("2026-11-17T11:30:00Z"), ET)).toBeNull();
  });
});
