// Reliability Unit B (design B.4.5, F-015): the carrier-anchored cycle
// engine, proven against the two WRONG methods on fixtures constructed
// so all three provably differ. The wrong answers are computed inline,
// in the test only, to prove each fixture discriminates:
//
// - rolling: the pre-Unit-B continuous window (now - 192h), no anchor,
//   no period boundaries - hours fall out minute-by-minute.
// - calendar: Rev 1's retracted model - viewer-local calendar days,
//   today + previous 7, bucketed by midnight.
//
// The engine must return the CARRIER-ANCHORED answer in every case;
// the calendar-day result is asserted to be the wrong answer.
//
// All fixtures use January 2026 in America/New_York (EST, UTC-5, no
// DST transitions) so every expected value is hand-verifiable.

import { describe, expect, it } from "vitest";
import { summarizeHosCycle, type HosCarrierConfig } from "@/lib/hos-cycle";
import { buildSegments, sumMinutes, type DutySegmentInput } from "@/lib/hos";
import { hosPeriodStartMs, shiftHosPeriodStartMs } from "@/lib/hos-periods";

function log(status: DutySegmentInput["duty_status"], started_at: string): DutySegmentInput {
  return { duty_status: status, started_at };
}

const MINUTE_MS = 60_000;

function rollingTotal(logs: DutySegmentInput[], now: Date, windowMs: number): number {
  const segments = buildSegments(logs, now.getTime());
  return sumMinutes(segments, now.getTime() - windowMs, now.getTime(), ["driving", "on_duty"]);
}

function calendarTotal(logs: DutySegmentInput[], now: Date, daysBack: number): number {
  // Viewer-local calendar days (viewer = America/New_York in these
  // fixtures): today + previous `daysBack` days, from that day's
  // midnight. Day-bucket summation is exactly this interval sum.
  const viewerCfg: HosCarrierConfig = {
    cycle: "70/8",
    periodAnchor: "00:00",
    restartEnabled: false,
    carrierTimeZone: "America/New_York",
  };
  const todayStart = hosPeriodStartMs(now.getTime(), viewerCfg);
  const from = shiftHosPeriodStartMs(todayStart, -daysBack, viewerCfg);
  const segments = buildSegments(logs, now.getTime());
  return sumMinutes(segments, from, now.getTime(), ["driving", "on_duty"]);
}

const CFG_0600_70: HosCarrierConfig = {
  cycle: "70/8",
  periodAnchor: "06:00",
  restartEnabled: true,
  carrierTimeZone: "America/New_York",
};
const CFG_0000_70: HosCarrierConfig = { ...CFG_0600_70, periodAnchor: "00:00" };

// ---------------------------------------------------------------------
// Fixture 1 - anchor shifts the total (B.4.5 fixture 1).
// Anchor 06:00 ET, 70/8, now = Jan 15 2026, 15:00 EST (20:00Z).
// Counted periods: current (began Jan 15 06:00 EST) + previous 7
// (began Jan 8 06:00 EST). The period that began Jan 7 06:00 EST
// (P-8) has dropped out whole.
//   P-8 duty: 10h on-duty, Jan 7 20:00 EST -> Jan 8 06:00 EST.
//   P-7..P0:  8h on-duty each, 06:00 -> 14:00 EST on Jan 8..Jan 15.
// Anchored: 8 x 8h = 64h = 3840 (the P-8 10h excluded whole).
// Rolling (192h back from now = Jan 7 15:00 EST): the P-8 block
//   (starts Jan 7 20:00 EST) lies entirely inside -> 74h = 4440.
// Calendar (ET days Jan 8..15): the P-8 block splits at midnight -
//   4h on Jan 7 (outside), 6h on Jan 8 (inside) -> 70h = 4200.
// ---------------------------------------------------------------------
const FIXTURE_1_LOGS: DutySegmentInput[] = [
  log("on_duty", "2026-01-08T01:00:00Z"), // Jan 7 20:00 EST
  log("off_duty", "2026-01-08T11:00:00Z"), // Jan 8 06:00 EST
];
for (let day = 8; day <= 15; day++) {
  const d = String(day).padStart(2, "0");
  FIXTURE_1_LOGS.push(log("on_duty", `2026-01-${d}T11:00:00Z`)); // 06:00 EST
  FIXTURE_1_LOGS.push(log("off_duty", `2026-01-${d}T19:00:00Z`)); // 14:00 EST
}
const FIXTURE_1_NOW = new Date("2026-01-15T20:00:00Z");

describe("Fixture 1 - anchor shifts the total (B.4.5)", () => {
  it("the three methods provably differ", () => {
    const rolling = rollingTotal(FIXTURE_1_LOGS, FIXTURE_1_NOW, 192 * 60 * MINUTE_MS);
    const calendar = calendarTotal(FIXTURE_1_LOGS, FIXTURE_1_NOW, 7);
    expect(rolling).toBe(4440);
    expect(calendar).toBe(4200);
    expect(new Set([3840, rolling, calendar]).size).toBe(3);
  });

  it("the engine returns the carrier-anchored answer - never the calendar one", () => {
    const result = summarizeHosCycle(FIXTURE_1_LOGS, FIXTURE_1_NOW, CFG_0600_70);
    expect(result.onDutyMinutesInCycle).toBe(3840);
    expect(result.cycle).toBe("70/8");
    expect(result.cycleLimitMinutes).toBe(4200);
    expect(result.windowStart).toBe("2026-01-08T11:00:00.000Z"); // Jan 8, 06:00 EST
    expect(result.currentPeriodStart).toBe("2026-01-15T11:00:00.000Z");
    expect(result.restartApplied).toBeNull();
    expect(result.restartUnverified).toBe(false);
  });
});

describe("Fixture 3 - the 60/7 flip (B.4.5)", () => {
  it("the same history under 60/7 counts one fewer period", () => {
    const result = summarizeHosCycle(FIXTURE_1_LOGS, FIXTURE_1_NOW, {
      ...CFG_0600_70,
      cycle: "60/7",
    });
    // Counted: current + previous 6 (Jan 9..15 periods) = 7 x 8h.
    expect(result.onDutyMinutesInCycle).toBe(3360);
    expect(result.cycleLimitMinutes).toBe(3600);
    expect(result.windowStart).toBe("2026-01-09T11:00:00.000Z"); // Jan 9, 06:00 EST
  });
});

// ---------------------------------------------------------------------
// Fixture 2 - period edge vs minute edge (B.4.5 fixture 2).
// Anchor 06:00 ET, 70/8, now = Jan 16 2026, 05:00 EST (10:00Z), so the
// current period began Jan 15 06:00 EST and the OLDEST counted period
// (P-7) began Jan 8 06:00 EST = 11:00Z. One 4h segment straddles that
// boundary: on-duty Jan 8 04:00 -> 08:00 EST (09:00Z -> 13:00Z). Each
// later period carries a 1h filler (06:00 -> 07:00 EST, Jan 9..15) so
// the history is a realistic continuous log - no rest reaches 34h, so
// no restart interferes with the boundary arithmetic under test.
// Anchored: P-7 half of the straddle (2h) + 7 x 1h fillers = 540.
// Rolling: the 192h edge (Jan 8 10:00Z) cuts the segment
//   minute-proportionally (3h) + fillers = 600.
// Calendar: the straddle sits on Jan 8; counted days are Jan 9..16,
//   so only the fillers count = 420.
// ---------------------------------------------------------------------
const FIXTURE_2_LOGS: DutySegmentInput[] = [
  log("off_duty", "2026-01-01T05:00:00Z"),
  log("on_duty", "2026-01-08T09:00:00Z"), // Jan 8 04:00 EST
  log("off_duty", "2026-01-08T13:00:00Z"), // Jan 8 08:00 EST
];
for (let day = 9; day <= 15; day++) {
  const d = String(day).padStart(2, "0");
  FIXTURE_2_LOGS.push(log("on_duty", `2026-01-${d}T11:00:00Z`)); // 06:00 EST
  FIXTURE_2_LOGS.push(log("off_duty", `2026-01-${d}T12:00:00Z`)); // 07:00 EST
}
const FIXTURE_2_NOW = new Date("2026-01-16T10:00:00Z");

describe("Fixture 2 - period edge vs minute edge (B.4.5)", () => {
  it("the anchored model excludes exactly the older period's share of the straddle", () => {
    const rolling = rollingTotal(FIXTURE_2_LOGS, FIXTURE_2_NOW, 192 * 60 * MINUTE_MS);
    const calendar = calendarTotal(FIXTURE_2_LOGS, FIXTURE_2_NOW, 7);
    expect(rolling).toBe(600);
    expect(calendar).toBe(420);
    expect(new Set([540, rolling, calendar]).size).toBe(3);

    const result = summarizeHosCycle(FIXTURE_2_LOGS, FIXTURE_2_NOW, CFG_0600_70);
    expect(result.onDutyMinutesInCycle).toBe(540);
    expect(result.windowStart).toBe("2026-01-08T11:00:00.000Z"); // P-7 start, Jan 8 06:00 EST
    expect(result.restartApplied).toBeNull();
    expect(result.restartUnverified).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Restart fixtures (B.4.5). Anchor 00:00 ET, 70/8.
// Duty before the restart: 10h on Jan 5 and 10h on Jan 6 (00:00-10:00
// EST). The rest interval: off duty from Jan 6 10:00 EST until the
// next status at Jan 7 20:00 EST - exactly 34h. After it: 8h on duty
// (Jan 7 20:00 -> Jan 8 04:00 EST) and 4h (Jan 9 00:00 -> 04:00 EST).
// now = Jan 9, 12:00 EST.
// Restart applied: counted from the period containing the restart's
//   completion (Jan 7's period) -> 8h + 4h = 720; the 20h before the
//   restart does not count. Without any restart the same history
//   totals 32h = 1920 (the conservative direction is visible here).
// ---------------------------------------------------------------------
const RESTART_LOGS: DutySegmentInput[] = [
  log("on_duty", "2026-01-05T05:00:00Z"),
  log("off_duty", "2026-01-05T15:00:00Z"),
  log("on_duty", "2026-01-06T05:00:00Z"),
  log("off_duty", "2026-01-06T15:00:00Z"), // rest begins Jan 6 10:00 EST
  log("on_duty", "2026-01-08T01:00:00Z"), // Jan 7 20:00 EST - 34h later
  log("off_duty", "2026-01-08T09:00:00Z"),
  log("on_duty", "2026-01-09T05:00:00Z"),
  log("off_duty", "2026-01-09T09:00:00Z"),
];
const RESTART_NOW = new Date("2026-01-09T17:00:00Z");

describe("34-hour restart (B.4.5)", () => {
  it("an observed qualifying restart excludes pre-restart duty and is labeled", () => {
    const result = summarizeHosCycle(RESTART_LOGS, RESTART_NOW, CFG_0000_70);
    expect(result.onDutyMinutesInCycle).toBe(720);
    expect(result.restartApplied).toEqual({ endedAt: "2026-01-08T01:00:00.000Z" });
    expect(result.restartUnverified).toBe(false);
    expect(result.windowStart).toBe("2026-01-07T05:00:00.000Z"); // Jan 7 period, 00:00 EST
  });

  it("with restart disabled, even a clean 34h interval does not reset the window", () => {
    const result = summarizeHosCycle(RESTART_LOGS, RESTART_NOW, {
      ...CFG_0000_70,
      restartEnabled: false,
    });
    expect(result.onDutyMinutesInCycle).toBe(1920);
    expect(result.restartApplied).toBeNull();
    expect(result.restartUnverified).toBe(false);
  });

  it("an unverifiable restart is NOT applied and is labeled unverified (conservative total)", () => {
    // The rest interval begins with the fetched sequence's FIRST
    // event, so its true start is not observed (B.2.5's ambiguous
    // case): the interval may have begun before the window. Apparent
    // length is exactly 34h - a candidate - but it must not be
    // trusted. Heavy duty follows it (12h x 3 = 36h), all inside the
    // normal counted window, so the reported total is the full,
    // un-restarted count.
    const logs: DutySegmentInput[] = [
      log("off_duty", "2026-01-04T11:00:00Z"), // Jan 4 06:00 EST - first event
      log("on_duty", "2026-01-05T21:00:00Z"), // Jan 5 16:00 EST - 34h later
      log("off_duty", "2026-01-06T09:00:00Z"),
      log("on_duty", "2026-01-06T11:00:00Z"),
      log("off_duty", "2026-01-06T23:00:00Z"),
      log("on_duty", "2026-01-07T11:00:00Z"),
      log("off_duty", "2026-01-07T23:00:00Z"),
    ];
    const result = summarizeHosCycle(logs, new Date("2026-01-08T17:00:00Z"), CFG_0000_70);
    expect(result.restartApplied).toBeNull();
    expect(result.restartUnverified).toBe(true);
    expect(result.onDutyMinutesInCycle).toBe(2160); // 36h - the conservative total
  });

  it("a restart older than the cycle has aged out: no label, no effect", () => {
    // Same restart as the applied case, but evaluated 20 periods
    // later: the normal window already starts after it.
    const result = summarizeHosCycle(RESTART_LOGS, new Date("2026-01-29T17:00:00Z"), CFG_0000_70);
    expect(result.restartApplied).toBeNull();
    expect(result.restartUnverified).toBe(false);
    expect(result.onDutyMinutesInCycle).toBe(0);
  });
});

// ---------------------------------------------------------------------
// Carrier-timezone separation (B.4.5b). A 3h on-duty segment straddles
// the New York midnight (Jan 1 23:00 -> Jan 2 02:00 EST) but not the
// Chicago one (22:00 -> 01:00 CST). now = Jan 9 12:00 EST, anchor
// 00:00, 70/8: the counted window opens at the Jan 2 period start in
// the CARRIER zone.
//   Carrier = New York: window opens Jan 2 00:00 EST -> 2h counted.
//   Carrier = Chicago:  window opens Jan 2 00:00 CST (= 01:00 EST)
//     -> 1h counted.
// The engine takes no viewer zone at all - the zone that governs is
// the carrier's, which is the property this test pins.
// ---------------------------------------------------------------------
describe("carrier-timezone separation (B.4.5b)", () => {
  const logs: DutySegmentInput[] = [
    log("on_duty", "2026-01-02T04:00:00Z"), // Jan 1 23:00 EST
    log("off_duty", "2026-01-02T07:00:00Z"), // Jan 2 02:00 EST
  ];
  const now = new Date("2026-01-09T17:00:00Z");
  // Restart is disabled in this test to isolate the boundary
  // arithmetic (the week of rest after the segment is not the subject
  // here; restart behavior has its own fixtures above).
  const noRestart: HosCarrierConfig = { ...CFG_0000_70, restartEnabled: false };

  it("period boundaries are computed in the carrier zone", () => {
    const ny = summarizeHosCycle(logs, now, noRestart);
    expect(ny.onDutyMinutesInCycle).toBe(120);
    expect(ny.carrierTimeZone).toBe("America/New_York");

    const chicago = summarizeHosCycle(logs, now, {
      ...noRestart,
      carrierTimeZone: "America/Chicago",
    });
    expect(chicago.onDutyMinutesInCycle).toBe(60);
    expect(chicago.windowStart).not.toBe(ny.windowStart);
  });
});

describe("completeness + basics", () => {
  it("B.4.4 engine half: 250 logs in the window sum exactly (no 200-row cap in the math)", () => {
    // 250 alternating status events, 30 minutes apart, from Jan 4
    // 00:00 EST - 125 on-duty segments of 30 minutes = 3750 minutes.
    // The old summary path silently truncated at 200 list rows; the
    // engine consumes whatever the window query returns.
    const logs: DutySegmentInput[] = [];
    const startMs = Date.parse("2026-01-04T05:00:00Z");
    for (let i = 0; i < 250; i++) {
      logs.push(
        log(i % 2 === 0 ? "on_duty" : "off_duty", new Date(startMs + i * 30 * MINUTE_MS).toISOString()),
      );
    }
    const result = summarizeHosCycle(logs, new Date("2026-01-10T05:00:00Z"), CFG_0000_70);
    expect(result.onDutyMinutesInCycle).toBe(3750);
    expect(result.restartApplied).toBeNull();
    expect(result.restartUnverified).toBe(false);
  });

  it("empty history: zero totals, no restart state", () => {
    const result = summarizeHosCycle([], RESTART_NOW, CFG_0000_70);
    expect(result.onDutyMinutesInCycle).toBe(0);
    expect(result.restartApplied).toBeNull();
    expect(result.restartUnverified).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("does not warn below the cycle limit", () => {
    const result = summarizeHosCycle(FIXTURE_1_LOGS, FIXTURE_1_NOW, {
      ...CFG_0600_70,
      cycle: "60/7",
    });
    expect(result.onDutyMinutesInCycle).toBe(3360); // < 3600 limit
    expect(result.warnings).toEqual([]);
  });

  it("warns when on-duty time reaches the 70h limit", () => {
    // 70h of on-duty inside the counted window: 7 periods x 10h.
    const logs: DutySegmentInput[] = [];
    for (let day = 2; day <= 8; day++) {
      const d = String(day).padStart(2, "0");
      logs.push(log("on_duty", `2026-01-${d}T05:00:00Z`)); // 00:00 EST
      logs.push(log("off_duty", `2026-01-${d}T15:00:00Z`)); // 10:00 EST
    }
    const result = summarizeHosCycle(logs, new Date("2026-01-09T17:00:00Z"), CFG_0000_70);
    expect(result.onDutyMinutesInCycle).toBe(4200);
    expect(result.warnings.some((w) => w.includes("70/8 on-duty limit reached"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("ELD/official log"))).toBe(true);
  });
});
