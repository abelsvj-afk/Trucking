// Driver MVP (docs/design/driver-mvp.md §3). The HOS summary math is
// the real logic worth getting wrong here - it feeds safety warnings.

import { describe, expect, it } from "vitest";
import { summarizeHos, type DutySegmentInput } from "@/lib/hos";

function log(status: DutySegmentInput["duty_status"], started_at: string): DutySegmentInput {
  return { duty_status: status, started_at };
}

const NOW = new Date("2026-11-01T20:00:00Z");

describe("summarizeHos", () => {
  it("returns an empty summary with no logs", () => {
    const result = summarizeHos([], NOW);
    expect(result.windowStart).toBeNull();
    expect(result.drivingMinutesInWindow).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("counts driving inside the window and elapsed window time", () => {
    const result = summarizeHos(
      [
        log("on_duty", "2026-11-01T12:00:00Z"),
        log("driving", "2026-11-01T13:00:00Z"),
        log("off_duty", "2026-11-01T18:00:00Z"),
      ],
      NOW,
    );
    expect(result.windowStart).toBe("2026-11-01T12:00:00.000Z");
    expect(result.drivingMinutesInWindow).toBe(300);
    expect(result.windowElapsedMinutes).toBe(480);
    expect(result.warnings).toEqual([]);
  });

  it("restarts the window after a continuous 10-hour rest", () => {
    const result = summarizeHos(
      [
        log("driving", "2026-10-31T20:00:00Z"),
        log("off_duty", "2026-10-31T23:00:00Z"),
        log("driving", "2026-11-01T09:00:00Z"),
        log("on_duty", "2026-11-01T11:00:00Z"),
      ],
      NOW,
    );
    // 23:00 -> 09:00 is exactly 10h of rest, so the window starts 09:00.
    expect(result.windowStart).toBe("2026-11-01T09:00:00.000Z");
    expect(result.drivingMinutesInWindow).toBe(120);
  });

  it("does not restart the window on a rest shorter than 10 hours", () => {
    const result = summarizeHos(
      [
        log("driving", "2026-11-01T00:00:00Z"),
        log("sleeper", "2026-11-01T04:00:00Z"),
        log("driving", "2026-11-01T12:00:00Z"),
        log("off_duty", "2026-11-01T14:00:00Z"),
      ],
      NOW,
    );
    expect(result.windowStart).toBe("2026-11-01T00:00:00.000Z");
    expect(result.drivingMinutesInWindow).toBe(240 + 120);
  });

  it("resets the break clock after 30 minutes not driving", () => {
    // Evaluated at 16:00, the moment the second driving block ends -
    // evaluated later (after the trailing off_duty itself passes 30
    // minutes) the honest answer would be 0, since that rest is also
    // a qualifying break.
    const result = summarizeHos(
      [
        log("driving", "2026-11-01T08:00:00Z"),
        log("on_duty", "2026-11-01T13:00:00Z"), // not-driving 13:00-14:00 = a qualifying break
        log("driving", "2026-11-01T14:00:00Z"),
      ],
      new Date("2026-11-01T16:00:00Z"),
    );
    expect(result.drivingMinutesSinceBreak).toBe(120);
  });

  it("counts a completed rest after driving as a break (clock back to 0)", () => {
    const result = summarizeHos(
      [log("driving", "2026-11-01T08:00:00Z"), log("off_duty", "2026-11-01T13:00:00Z")],
      NOW,
    );
    expect(result.drivingMinutesSinceBreak).toBe(0);
  });

  it("warns when driving since the last break reaches 8 hours", () => {
    const result = summarizeHos(
      [log("driving", "2026-11-01T08:00:00Z")],
      new Date("2026-11-01T17:00:00Z"), // 9 straight driving hours, no break yet
    );
    expect(result.drivingMinutesSinceBreak).toBe(540);
    expect(result.warnings.some((w) => w.includes("30-minute break"))).toBe(true);
  });

  it("warns at the 11-hour driving limit", () => {
    const result = summarizeHos(
      [log("driving", "2026-11-01T06:00:00Z"), log("off_duty", "2026-11-01T18:00:00Z")],
      NOW,
    );
    expect(result.drivingMinutesInWindow).toBe(720);
    expect(result.warnings.some((w) => w.includes("Driving limit"))).toBe(true);
  });

  it("sums driving + on-duty across the last 8 days and warns at 70 hours", () => {
    const logs: DutySegmentInput[] = [];
    // 6 days of 10h on-duty each = 60h, then a 10h driving day = 70h.
    for (let day = 25; day <= 30; day++) {
      logs.push(log("on_duty", `2026-10-${day}T08:00:00Z`));
      logs.push(log("off_duty", `2026-10-${day}T18:00:00Z`));
    }
    logs.push(log("driving", "2026-11-01T06:00:00Z"));
    logs.push(log("off_duty", "2026-11-01T16:00:00Z"));

    const result = summarizeHos(logs, NOW);
    expect(result.onDutyMinutesLast8Days).toBe(70 * 60);
    expect(result.warnings.some((w) => w.includes("70-hour"))).toBe(true);
  });

  it("ignores logs that start in the future", () => {
    const result = summarizeHos(
      [log("driving", "2026-11-01T12:00:00Z"), log("off_duty", "2026-11-03T12:00:00Z")],
      NOW,
    );
    // The future off_duty must not end the driving segment early - the
    // driving segment runs to "now" (12:00 -> 20:00 = 480 minutes).
    expect(result.drivingMinutesInWindow).toBe(480);
  });
});
