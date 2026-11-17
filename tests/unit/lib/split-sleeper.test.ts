// Split sleeper berth (49 CFR 395.1(g)(1)(ii), property carriers; docs/design/split-sleeper.md). Every number here
// is worked out by hand from the rule: >=7 straight hours in the SLEEPER + a separate >=2 h off/sleeper, >=10 total,
// either order; paired, neither counts against the 14, and the clocks run from the end of the FIRST period.
import { describe, expect, it } from "vitest";
import { buildSegments, findShortClockAnchor } from "@/lib/hos";
import { computeHudClocks } from "@/lib/hud-clocks";
import type { DutyStatus } from "@/types/entities";

const H = 3_600_000;
const T0 = Date.parse("2026-11-16T00:00:00Z");
/** [status, hours] in order from T0; returns rows and the end time. */
function day(parts: [DutyStatus, number][]) {
  let t = T0;
  const rows = parts.map(([s, h]) => {
    const r = { duty_status: s, started_at: new Date(t).toISOString() };
    t += h * H;
    return r;
  });
  return { rows, end: t };
}
const left = (rows: { duty_status: DutyStatus; started_at: string }[], now: number) => {
  const c = computeHudClocks(rows, null, now);
  if (c.state !== "ready") throw new Error("no clocks");
  const get = (k: string) => c.clocks.find((x) => x.key === k)!.remainingMs / H;
  return { drive: get("drive"), window: get("window"), split: c.split };
};

describe("split sleeper", () => {
  // 10 h off to start a clean day, then: drive 5, sleeper 8, drive 3, off 2, now (driving resumes).
  it("8/2: clocks run from the end of the 8-hour sleeper; the 2-hour rest doesn't count against the 14", () => {
    const { rows, end } = day([["off_duty", 10], ["driving", 5], ["sleeper", 8], ["driving", 3], ["off_duty", 2], ["driving", 0]]);
    const l = left(rows, end);
    // from the end of the sleeper: drove 3 -> 8 h driving left; elapsed 3 + 2 (excluded) -> 14 - 3 = 11 h window left
    expect(l.drive).toBeCloseTo(8);
    expect(l.window).toBeCloseTo(11);
    expect(l.split).toContain("Split sleeper in use (8h + 2h)");
  });

  it("7/3 works the same way", () => {
    const { rows, end } = day([["off_duty", 10], ["driving", 6], ["sleeper", 7], ["driving", 2], ["off_duty", 3], ["driving", 0]]);
    expect(left(rows, end)).toMatchObject({ drive: expect.closeTo(9), window: expect.closeTo(12) });
  });

  it("order doesn't matter: 2 off first, then 8 in the sleeper - clocks run from the end of the 2-hour rest", () => {
    const { rows, end } = day([["off_duty", 10], ["driving", 4], ["off_duty", 2], ["driving", 3], ["sleeper", 8], ["driving", 0]]);
    // from the end of the 2 h rest: drove 3 -> 8 left; elapsed 3 + 8 (excluded) -> 11 window left
    expect(left(rows, end)).toMatchObject({ drive: expect.closeTo(8), window: expect.closeTo(11) });
  });

  it("near misses are NOT a split: 7 h OFF DUTY (not sleeper), 6 h sleeper, or under 10 h total", () => {
    for (const parts of [
      [["off_duty", 10], ["driving", 4], ["off_duty", 7], ["driving", 2], ["off_duty", 3], ["driving", 0]],
      [["off_duty", 10], ["driving", 4], ["sleeper", 6], ["driving", 2], ["off_duty", 4], ["driving", 0]],
      [["off_duty", 10], ["driving", 4], ["sleeper", 7], ["driving", 2], ["off_duty", 2], ["driving", 0]],
    ] as [DutyStatus, number][][]) {
      const { rows, end } = day(parts);
      const a = findShortClockAnchor(buildSegments(rows, end))!;
      expect(a.split, JSON.stringify(parts)).toBeNull();
      expect(a.startMs).toBe(T0 + 10 * H); // still from the full 10-hour reset
    }
  });

  it("chains: 8 sleeper, 2 off, 8 sleeper - the newest pair (2 + 8) wins", () => {
    const { rows, end } = day([["off_duty", 10], ["driving", 3], ["sleeper", 8], ["driving", 3], ["off_duty", 2], ["driving", 4], ["sleeper", 8], ["driving", 0]]);
    const a = findShortClockAnchor(buildSegments(rows, end))!;
    expect(a.startMs).toBe(T0 + (10 + 3 + 8 + 3 + 2) * H);
    expect(a.excludedMs).toBe(8 * H);
    // drove 4 since the 2 h rest -> 7 left; elapsed 4 + 8 (excluded) -> 10 window left
    expect(left(rows, end)).toMatchObject({ drive: expect.closeTo(7), window: expect.closeTo(10) });
  });

  it("half a split says what's still needed; a plain 10-hour rest is unchanged", () => {
    const half = day([["off_duty", 10], ["driving", 5], ["sleeper", 8], ["driving", 1]]);
    expect(left(half.rows, half.end).split).toContain("first half - take at least 2h 00m more off duty or in the sleeper");
    const reset = day([["driving", 5], ["off_duty", 10], ["driving", 2]]);
    expect(left(reset.rows, reset.end)).toMatchObject({ drive: expect.closeTo(9), window: expect.closeTo(12), split: null });
  });
});
