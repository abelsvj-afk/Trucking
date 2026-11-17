// Day-aware manual clock reset (owner 2026-11-17 ~11:42 CT):
// the reset re-derives the clocks from TODAY's real log - it does
// NOT wipe the day to fresh. Driving already done today still
// counts against the 11, on-duty time today still counts against
// the 14, breaks and stops today still count, and a qualifying rest
// period already taken today can still pair for a split. The reset
// fixes a wrong derivation/anchor, not wrong entries.
import { describe, expect, it } from "vitest";
import { buildSegments, findShortClockAnchor, summarizeDaySoFar, summarizeHos } from "@/lib/hos";
import { computeHudClocks } from "@/lib/hud-clocks";
import type { DutyStatus } from "@/types/entities";

const H = 3_600_000;
const T0 = Date.parse("2026-11-16T00:00:00Z");
function day(parts: [DutyStatus, number][], start = T0) {
  let t = start;
  const rows = parts.map(([s, h]) => {
    const r = { duty_status: s, started_at: new Date(t).toISOString() };
    t += h * H;
    return r;
  });
  return { rows, end: t };
}

describe("day-aware clock reset", () => {
  it("a stale split pair from yesterday does not anchor today - only today's 5h of driving counts", () => {
    // Yesterday: 10h off, drive 2, sleeper 8, drive 2, off 2 (a completed 8/2 pair, anchor = end of the sleeper).
    // Today (from T0): drive 5, now. Without the reset the clocks run from yesterday's pair: 7h driven since
    // the anchor (2 + 5), so 4h drive left and the window is nearly used up.
    const { rows, end } = day(
      [
        ["off_duty", 10],
        ["driving", 2],
        ["sleeper", 8],
        ["driving", 2],
        ["off_duty", 2],
        ["driving", 5],
        ["driving", 0],
      ],
      T0 - 24 * H,
    );
    const plain = computeHudClocks(rows, null, end);
    expect(plain.state).toBe("ready");
    if (plain.state !== "ready") throw new Error("no clocks");
    expect(plain.clocks.find((c) => c.key === "drive")!.remainingMs).toBe(4 * H);
    // With the reset (day starts at T0): the anchor is today's first duty, today's 5h counts, yesterday's 2h
    // after the pair does not - 6h drive left, 9h window left.
    const reset = computeHudClocks(rows, null, end, { resetDayStartMs: T0 });
    expect(reset.state).toBe("ready");
    if (reset.state !== "ready") throw new Error("no clocks");
    expect(reset.clocks.find((c) => c.key === "drive")!.remainingMs).toBe(6 * H);
    expect(reset.clocks.find((c) => c.key === "window")!.remainingMs).toBe(9 * H);
  });

  it("summarizeHos counts the same day-aware way: 5h driven today, not 7h", () => {
    const { rows, end } = day(
      [
        ["off_duty", 10],
        ["driving", 2],
        ["sleeper", 8],
        ["driving", 2],
        ["off_duty", 2],
        ["driving", 5],
        ["driving", 0],
      ],
      T0 - 24 * H,
    );
    const summary = summarizeHos(rows, new Date(end), { resetDayStartMs: T0 });
    expect(summary.drivingMinutesInWindow).toBe(5 * 60);
    expect(summary.windowElapsedMinutes).toBe(5 * 60);
  });

  it("a pending first period from today survives the reset and can still be offered", () => {
    // Today: drive 2, sleeper 8 (first half), drive 1, now. The reset must not drop the 8h sleeper.
    const { rows, end } = day([["driving", 2], ["sleeper", 8], ["driving", 1], ["driving", 0]]);
    const anchor = findShortClockAnchor(buildSegments(rows, end), { dayStartMs: T0 })!;
    expect(anchor.pending).not.toBeNull();
    expect(anchor.pending!.period.endMs - anchor.pending!.period.startMs).toBe(8 * H);
    const clocks = computeHudClocks(rows, null, end, { resetDayStartMs: T0 });
    expect(clocks.state).toBe("ready");
    if (clocks.state !== "ready") throw new Error("no clocks");
    expect(clocks.split).toContain("first half");
    // Drive is at 8h left and window at 11h left - not urgent, so the quiet note stands and no popup fires.
    expect(clocks.splitOffer).toBeNull();
  });

  it("a night's rest straddling midnight survives: sleeper 10pm-6am is still the first period", () => {
    // Day starts at T0 (midnight). Sleeper 10pm-6am straddles it, then drive 2, now.
    const { rows, end } = day(
      [
        ["driving", 2],
        ["sleeper", 8],
        ["driving", 2],
        ["driving", 0],
      ],
      T0 - 2 * H,
    );
    const anchor = findShortClockAnchor(buildSegments(rows, end), { dayStartMs: T0 })!;
    expect(anchor.pending).not.toBeNull();
    expect(anchor.pending!.period.endMs - anchor.pending!.period.startMs).toBe(8 * H);
  });

  it("no duty logged today yet -> the reset changes nothing", () => {
    // Yesterday: drive 5, then off duty through now (today). No non-driving... no DUTY segment ends today.
    const { rows, end } = day(
      [
        ["driving", 5],
        ["off_duty", 10],
        ["off_duty", 0],
      ],
      T0 - 15 * H,
    );
    const plain = computeHudClocks(rows, null, end);
    const reset = computeHudClocks(rows, null, end, { resetDayStartMs: T0 });
    expect(plain.state).toBe("ready");
    expect(reset.state).toBe("ready");
    if (plain.state !== "ready" || reset.state !== "ready") throw new Error("no clocks");
    expect(reset.clocks.map((c) => c.remainingMs)).toEqual(plain.clocks.map((c) => c.remainingMs));
  });

  it("a full 10-hour rest today still fully resets, under the reset too", () => {
    const { rows, end } = day([["off_duty", 10], ["driving", 3], ["driving", 0]]);
    const clocks = computeHudClocks(rows, null, end, { resetDayStartMs: T0 });
    expect(clocks.state).toBe("ready");
    if (clocks.state !== "ready") throw new Error("no clocks");
    expect(clocks.clocks.find((c) => c.key === "drive")!.remainingMs).toBe(8 * H);
    expect(clocks.clocks.find((c) => c.key === "window")!.remainingMs).toBe(11 * H);
  });

  it("summarizeDaySoFar counts today's driving, on-duty time and 30+ minute breaks", () => {
    // Today: drive 4, on duty 1 + off 1 (one continuous 2-hour stop - on-duty-not-driving counts as not driving),
    // drive 2, sleeper 0.5 (a second stop), drive 1, now.
    const { rows, end } = day([
      ["driving", 4],
      ["on_duty", 1],
      ["off_duty", 1],
      ["driving", 2],
      ["sleeper", 0.5],
      ["driving", 1],
      ["driving", 0],
    ]);
    const soFar = summarizeDaySoFar(buildSegments(rows, end), T0, end);
    expect(soFar.drivenMs).toBe(7 * H);
    expect(soFar.onDutyMs).toBe(8 * H);
    expect(soFar.breakCount).toBe(2);
    expect(soFar.breakTotalMs).toBe(2.5 * H);
  });
});
