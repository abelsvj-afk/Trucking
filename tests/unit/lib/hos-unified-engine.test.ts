// Federal compliance audit §6 item #5 (2026-11-14): ONE HOS engine.
// The simple engine's cycle math (rolling 8-day sum, hardcoded 70h,
// no 34-hour restart) was retired from lib/hos.ts; the cycle engine
// (lib/hos-cycle.ts) is the only weekly math, reached by every surface
// through the same window snapshot (services/api/hos-window.ts).
//
// These tests prove the unification from the snapshot outward - the
// same snapshot the Home page, the Hours page, the HUD, Abel, and the
// roadside packet all read - so agreement here IS agreement on the
// surfaces. Every expected value is hand-computed in the comments;
// no expected value is copied from a run of the code under test
// (the fixtures are built so the old two-engine answers differ from
// the unified answer, and the differing number is asserted).
//
// All fixtures use January 2026 in America/New_York (EST, UTC-5, no
// DST transitions) with anchor 00:00 unless stated, so period
// boundaries are plain EST midnights.

import { describe, expect, it } from "vitest";
import { summarizeHos, type DutySegmentInput } from "@/lib/hos";
import { computeHudClocks } from "@/lib/hud-clocks";
import type { HosCarrierConfig } from "@/lib/hos-cycle";
import {
  cycleLine,
  hosWarnings,
  snapshotFromRows,
  toWindowSummary,
} from "@/services/api/hos-window";
import type { DutyLog } from "@/types/entities";

function log(status: DutySegmentInput["duty_status"], started_at: string): DutyLog {
  return { duty_status: status, started_at } as DutyLog;
}

const CFG_70: HosCarrierConfig = {
  cycle: "70/8",
  periodAnchor: "00:00",
  restartEnabled: true,
  carrierTimeZone: "America/New_York",
};
const CFG_60: HosCarrierConfig = { ...CFG_70, cycle: "60/7" };
const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------
// Fixture R - a 34-hour restart inside the cycle (anchor 00:00 ET).
// Duty before the restart: 10h on Jan 5 and 10h on Jan 6 (00:00-10:00
// EST). Rest: off duty Jan 6 10:00 EST -> Jan 7 20:00 EST, exactly
// 34h. After it: 8h on duty (Jan 7 20:00 -> Jan 8 04:00 EST) and 4h
// (Jan 9 00:00 -> 04:00 EST). now = Jan 9, 12:00 EST.
// Unified answer: 8h + 4h = 720 counted; the 20h before the restart
// does not count. The RETIRED simple engine would have answered
// 32h = 1920 (rolling 8-day sum, no restart handling) and warned at
// 70h only past that - the wrong total in the wrong direction.
// ---------------------------------------------------------------------
const RESTART_LOGS: DutyLog[] = [
  log("on_duty", "2026-01-05T05:00:00Z"),
  log("off_duty", "2026-01-05T15:00:00Z"),
  log("on_duty", "2026-01-06T05:00:00Z"),
  log("off_duty", "2026-01-06T15:00:00Z"), // rest begins Jan 6 10:00 EST
  log("on_duty", "2026-01-08T01:00:00Z"), // Jan 7 20:00 EST - 34h later
  log("off_duty", "2026-01-08T09:00:00Z"),
  log("on_duty", "2026-01-09T05:00:00Z"),
  log("off_duty", "2026-01-09T09:00:00Z"),
];
const RESTART_NOW = new Date("2026-01-09T17:00:00Z"); // Jan 9 12:00 EST

// ---------------------------------------------------------------------
// Fixture C - one history, two cycles (anchor 06:00 ET).
// 9h driving per period, Jan 9..15 (06:00 -> 15:00 EST each day),
// 15h rest between days (never a 34h restart, so the restart cannot
// interfere with the cycle comparison).
// 70/8 counts Jan 8..15 (8 periods): 7 x 9h = 3780 < 4200 - no warning.
// 60/7 counts Jan 9..15 (7 periods): 7 x 9h = 3780 >= 3600 - warns.
// The RETIRED simple engine would have answered 3780 against a
// hardcoded 70h limit under BOTH settings - no warning either way.
// ---------------------------------------------------------------------
const CYCLE_LOGS: DutyLog[] = [];
for (let day = 9; day <= 15; day++) {
  const d = String(day).padStart(2, "0");
  CYCLE_LOGS.push(log("driving", `2026-01-${d}T11:00:00Z`)); // 06:00 EST
  CYCLE_LOGS.push(log("off_duty", `2026-01-${d}T20:00:00Z`)); // 15:00 EST
}
const CYCLE_NOW = new Date("2026-01-16T01:00:00Z"); // Jan 15 20:00 EST
const CFG_0600_70: HosCarrierConfig = { ...CFG_70, periodAnchor: "06:00" };
const CFG_0600_60: HosCarrierConfig = { ...CFG_0600_70, cycle: "60/7" };

function hudCycleMinutes(snapshot: ReturnType<typeof snapshotFromRows>, now: Date) {
  const clocks = computeHudClocks(snapshot.rows, toWindowSummary(snapshot), now.getTime());
  expect(clocks.state).toBe("ready");
  if (clocks.state !== "ready") throw new Error("unreachable");
  const cycle = clocks.clocks.find((c) => c.key === "cycle");
  expect(cycle).toBeDefined();
  return {
    remainingMinutes: cycle!.remainingMs / MINUTE_MS,
    totalMinutes: cycle!.totalMs / MINUTE_MS,
    tone: cycle!.tone,
  };
}

describe("one engine: a 34-hour break resets the 70-hour clock", () => {
  it("the snapshot counts only post-restart duty and labels the restart", () => {
    const snap = snapshotFromRows(RESTART_LOGS, CFG_70, RESTART_NOW);
    expect(snap.cycle.onDutyMinutesInCycle).toBe(720);
    expect(snap.cycle.cycleLimitMinutes).toBe(4200);
    expect(snap.cycle.restartApplied).toEqual({ endedAt: "2026-01-08T01:00:00.000Z" });
    expect(snap.cycle.restartUnverified).toBe(false);
    expect(snap.cycle.windowStart).toBe("2026-01-07T05:00:00.000Z"); // Jan 7 period, 00:00 EST
    // The retired answer (1920) must not appear anywhere in the snapshot.
    expect(snap.cycle.onDutyMinutesInCycle).not.toBe(1920);
  });

  it("the short-term summary carries no cycle figure and no cycle warning", () => {
    const snap = snapshotFromRows(RESTART_LOGS, CFG_70, RESTART_NOW);
    expect(snap.short).not.toHaveProperty("onDutyMinutesLast8Days");
    expect(snap.short.warnings).toEqual([]);
    // The short engine on its own (what Home/HOS call directly) agrees:
    // no 70-hour / 8-day wording can leak from it any more.
    const short = summarizeHos(RESTART_LOGS, RESTART_NOW);
    expect(short.warnings.some((w) => /70-hour|8-day/.test(w))).toBe(false);
  });

  it("Home/HOS warnings and the HUD cycle clock agree after the restart", () => {
    const snap = snapshotFromRows(RESTART_LOGS, CFG_70, RESTART_NOW);
    // Home + HOS both render hosWarnings(snapshot): short warnings plus
    // the cycle's own - one cycle number, from the one engine.
    expect(hosWarnings(snap)).toEqual([]);
    expect(cycleLine(snap)).toContain("on duty 12h 00m of 70h 00m, 58h 00m left");
    expect(cycleLine(snap)).toContain("A 34-hour restart was applied");
    // The HUD cycle ring reads the same snapshot via toWindowSummary.
    const hud = hudCycleMinutes(snap, RESTART_NOW);
    expect(hud.totalMinutes).toBe(4200);
    expect(hud.remainingMinutes).toBe(4200 - 720);
    expect(hud.tone).toBe("ok");
  });

  it("the restart resets the clock under 60/7 as well", () => {
    const snap = snapshotFromRows(RESTART_LOGS, CFG_60, RESTART_NOW);
    expect(snap.cycle.onDutyMinutesInCycle).toBe(720);
    expect(snap.cycle.restartApplied).toEqual({ endedAt: "2026-01-08T01:00:00.000Z" });
    const hud = hudCycleMinutes(snap, RESTART_NOW);
    expect(hud.totalMinutes).toBe(3600);
    expect(hud.remainingMinutes).toBe(3600 - 720);
  });
});

describe("one engine: the cycle setting changes the limit", () => {
  it("the same history counts the same hours against a different limit", () => {
    const snap70 = snapshotFromRows(CYCLE_LOGS, CFG_0600_70, CYCLE_NOW);
    const snap60 = snapshotFromRows(CYCLE_LOGS, CFG_0600_60, CYCLE_NOW);
    expect(snap70.cycle.onDutyMinutesInCycle).toBe(3780);
    expect(snap70.cycle.cycleLimitMinutes).toBe(4200);
    expect(snap60.cycle.onDutyMinutesInCycle).toBe(3780);
    expect(snap60.cycle.cycleLimitMinutes).toBe(3600);
  });

  it("60/7 warns where 70/8 stays silent on the identical history", () => {
    const snap70 = snapshotFromRows(CYCLE_LOGS, CFG_0600_70, CYCLE_NOW);
    const snap60 = snapshotFromRows(CYCLE_LOGS, CFG_0600_60, CYCLE_NOW);
    expect(snap70.cycle.warnings).toEqual([]);
    expect(snap60.cycle.warnings).toHaveLength(1);
    expect(snap60.cycle.warnings[0]).toContain("60/7 on-duty limit reached");
    // The warning reaches Home/HOS through hosWarnings in both cases -
    // under 70/8 there is no cycle warning to show at all.
    expect(hosWarnings(snap70).some((w) => w.includes("on-duty limit reached"))).toBe(false);
    expect(hosWarnings(snap60).some((w) => w.includes("60/7 on-duty limit reached"))).toBe(true);
  });

  it("the short-term clocks are identical under both cycles (no cycle math left in them)", () => {
    const snap70 = snapshotFromRows(CYCLE_LOGS, CFG_0600_70, CYCLE_NOW);
    const snap60 = snapshotFromRows(CYCLE_LOGS, CFG_0600_60, CYCLE_NOW);
    expect(snap60.short).toEqual(snap70.short);
    // And the values are the hand-computed ones: the last 10h+ rest
    // ended Jan 15 06:00 EST, so the window is Jan 15 06:00 -> 20:00
    // (14h elapsed), 9h driving in it, and driving since the last
    // break is 0 - the trailing 5h off duty is itself a qualifying
    // 30-minute break. The one short warning is the 14-hour window.
    expect(snap70.short.windowStart).toBe("2026-01-15T11:00:00.000Z");
    expect(snap70.short.drivingMinutesInWindow).toBe(540);
    expect(snap70.short.drivingMinutesSinceBreak).toBe(0);
    expect(snap70.short.windowElapsedMinutes).toBe(840);
    expect(snap70.short.warnings).toHaveLength(1);
    expect(snap70.short.warnings[0]).toContain("14-hour window is used up");
  });

  it("the HUD cycle ring agrees with the snapshot under both cycles", () => {
    const snap70 = snapshotFromRows(CYCLE_LOGS, CFG_0600_70, CYCLE_NOW);
    const snap60 = snapshotFromRows(CYCLE_LOGS, CFG_0600_60, CYCLE_NOW);
    const hud70 = hudCycleMinutes(snap70, CYCLE_NOW);
    expect(hud70.totalMinutes).toBe(4200);
    expect(hud70.remainingMinutes).toBe(4200 - 3780);
    expect(hud70.tone).toBe("ok");
    const hud60 = hudCycleMinutes(snap60, CYCLE_NOW);
    expect(hud60.totalMinutes).toBe(3600);
    expect(hud60.remainingMinutes).toBe(0);
    expect(hud60.tone).toBe("expired");
  });
});
