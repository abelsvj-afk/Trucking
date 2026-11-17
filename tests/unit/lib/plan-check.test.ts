// Abel plan check (owner 2026-11-17): "how does this plan fit my
// drive time / delivery window / the load?" Pure evaluation against
// his REAL clocks, the load's windows, and the split sleeper rule.
//
// The owner's example shape is an acceptance case here (arrive by a
// stated time, a personal stop, sleep there, drop in the morning) —
// it is a TEST SHAPE ONLY, never his real plan and never a hardcoded
// destination: Ocala appears in tests and nowhere else.

import { describe, expect, it } from "vitest";
import {
  evaluatePlan,
  formatPlanVerdict,
  pairMeetsRuleD,
  segmentsFromLogs,
  type PlanClocks,
  type PlanEventInput,
  type PlanWindows,
} from "@/lib/plan-check";
import { buildSegments } from "@/lib/hos";

const NOW = new Date("2026-11-17T14:00:00Z").getTime();
const H = 3_600_000;

const clocks = (driveH: number, windowH: number, cycleH: number | null = 40): PlanClocks => ({
  driveLeftMs: driveH * H,
  windowLeftMs: windowH * H,
  breakDueInMs: 8 * H,
  cycleLeftMs: cycleH === null ? null : cycleH * H,
});

const ev = (label: string, driveMinutes: number, dwellMinutes: number, extra: Partial<PlanEventInput> = {}): PlanEventInput => ({
  label,
  driveMinutes,
  dwellMinutes,
  ...extra,
});

const run = (
  events: PlanEventInput[],
  clockValues: PlanClocks,
  segments: ReturnType<typeof buildSegments> = [],
  windows: PlanWindows = {},
  assumedFull = false,
) => evaluatePlan({ events, clocks: clockValues, segments, windows, nowMs: NOW, assumedFullClocks: assumedFull });

describe("evaluatePlan", () => {
  it("fits a simple plan inside his hours and the delivery appointment", () => {
    const result = run(
      [
        ev("Fuel stop", 120, 30),
        ev("Drop the load", 60, 0, { loadStop: "delivery", arriveByMs: NOW + 5 * H }),
      ],
      clocks(5, 10),
      [],
      { delivery: { startMs: NOW + 5 * H, endMs: NOW + 5 * H } },
    );
    expect(result.verdict).toBe("fits");
    expect(result.splitOption).toBeNull();
    expect(result.driveLeftAfterMs).toBe(2 * H);
    expect(result.arrivalMs).toBe(NOW + 3.5 * H);
  });

  it("does not fit when the delivery appointment is missed", () => {
    const result = run(
      [ev("Drop the load", 240, 0, { loadStop: "delivery", arriveByMs: NOW + 3 * H })],
      clocks(5, 10),
      [],
      { delivery: { startMs: NOW + 3 * H, endMs: NOW + 3 * H } },
    );
    expect(result.verdict).toBe("does-not-fit");
    expect(result.splitOption).toBeNull();
    expect(result.reasons.join(" ")).toContain("late");
  });

  it("does not fit when the 14-hour window runs out, and names the reset it would need", () => {
    const result = run(
      [
        ev("Wait at the shipper", 120, 180),
        ev("Drop the load", 120, 0, { loadStop: "delivery", arriveByMs: NOW + 6 * H }),
      ],
      clocks(9, 4),
      [],
      { delivery: { startMs: NOW + 6 * H, endMs: NOW + 6 * H } },
    );
    expect(result.verdict).toBe("does-not-fit");
    expect(result.requiredResets).toHaveLength(1);
    expect(result.reasons.join(" ")).toContain("late");
  });

  it("does not fit when the 60/70-hour cycle runs out, and says a split does not touch the cycle", () => {
    const result = run(
      [ev("Drop the load", 120, 0, { loadStop: "delivery", arriveByMs: NOW + 5 * H })],
      clocks(11, 14, 1),
      [],
      { delivery: { startMs: NOW + 5 * H, endMs: NOW + 5 * H } },
    );
    expect(result.verdict).toBe("does-not-fit");
    expect(result.cycleShort).toBe(true);
    expect(result.reasons.join(" ")).toContain("cycle");
  });

  it("fits with a split break when the plan already holds both rests", () => {
    const result = run(
      [
        ev("Stop for a break", 120, 180, { restKind: "off_duty" }),
        ev("Sleep in the sleeper", 180, 420, { restKind: "sleeper" }),
        ev("Drop the load", 240, 0, { loadStop: "delivery", arriveByMs: NOW + 22 * H }),
      ],
      clocks(10, 12),
      [],
      { delivery: { startMs: NOW + 22 * H, endMs: NOW + 22 * H } },
    );
    expect(result.verdict).toBe("fits-with-break");
    expect(result.splitOption?.firstLabel).toBe("Stop for a break");
    expect(result.splitOption?.secondLabel).toBe("Sleep in the sleeper");
    expect(result.splitOption?.windowMovesToMs).toBe(NOW + 26 * H);
    expect(result.driveLeftAfterMs).toBe(4 * H);
    expect(result.arrivalMs).toBe(NOW + 19 * H);
    expect(result.splitOption?.line).toContain("split sleeper break");
  });

  it("the owner's example shape: arrive by a stated time, personal stop, sleep there, morning drop", () => {
    // A 2-hour break before the sleep plus the 8-hour sleep is 10
    // hours off duty in a row — a full reset, better than a split —
    // so the break is offered as a reset, not a split pair.
    const result = run(
      [
        ev("Get to Ocala", 180, 120, { arriveByMs: NOW + 4 * H }),
        ev("Sleep in Ocala", 0, 480, { restKind: "sleeper" }),
        ev("Drop the load", 120, 0, { loadStop: "delivery", arriveByMs: NOW + 20 * H }),
      ],
      clocks(11, 14),
      [],
      { delivery: { startMs: NOW + 20 * H, endMs: NOW + 20 * H } },
    );
    expect(result.verdict).toBe("fits-with-break");
    expect(result.splitOption).toBeNull();
    expect(result.reasons.join(" ")).toContain("2h break");
    expect(result.reasons.join(" ")).toContain("10 hours off duty");
    expect(result.reasons.join(" ")).toContain("full reset");
    expect(result.driveLeftAfterMs).toBe(9 * H);
    expect(result.arrivalMs).toBe(NOW + 17 * H);
  });

  it("does not offer the split pair that breaks (ii)(D) — and no other break saves it either", () => {
    // Real logs: 6h driving, a 3h rest already taken, then 6h driving.
    // Pairing that 3h rest with the overnight sleep would put 6h + 6h
    // of driving around it — over the 11-hour (ii)(D) limit — so the
    // rest he already took must NOT be offered as the first period.
    // A 2-hour break plus the 7-hour sleep is only 9 hours, one short
    // of a pair, and a 7-hour break would make the drop late — so the
    // honest answer is that the plan does not fit.
    const segments = buildSegments(
      [
        { duty_status: "driving", started_at: new Date(NOW - 15 * H).toISOString() },
        { duty_status: "off_duty", started_at: new Date(NOW - 9 * H).toISOString() },
        { duty_status: "driving", started_at: new Date(NOW - 6 * H).toISOString() },
      ],
      NOW,
    );
    const result = run(
      [
        ev("Sleep in the sleeper", 0, 420, { restKind: "sleeper" }),
        ev("Drop the load", 240, 0, { loadStop: "delivery", arriveByMs: NOW + 16 * H }),
      ],
      clocks(5, 8),
      segments,
      { delivery: { startMs: NOW + 16 * H, endMs: NOW + 16 * H } },
    );
    expect(result.verdict).toBe("does-not-fit");
    expect(result.splitOption).toBeNull();
    expect(result.reasons.join(" ")).toContain("late");
  });
});

describe("pairMeetsRuleD", () => {
  it("rejects 6h driving before + 6h after a rest period (over 11h)", () => {
    const segments = buildSegments(
      [
        { duty_status: "driving", started_at: new Date(NOW - 19 * H).toISOString() },
        { duty_status: "off_duty", started_at: new Date(NOW - 13 * H).toISOString() },
        { duty_status: "driving", started_at: new Date(NOW - 10 * H).toISOString() },
        { duty_status: "sleeper", started_at: new Date(NOW - 4 * H).toISOString() },
      ],
      NOW,
    );
    expect(
      pairMeetsRuleD(
        segments,
        { startMs: NOW - 13 * H, endMs: NOW - 10 * H, longestSleeperMs: 0 },
        { startMs: NOW - 4 * H, endMs: NOW + 3 * H, longestSleeperMs: 7 * H },
      ),
    ).toBe(false);
  });

  it("accepts 4h driving before + 4h after a rest period", () => {
    const segments = buildSegments(
      [
        { duty_status: "driving", started_at: new Date(NOW - 15 * H).toISOString() },
        { duty_status: "off_duty", started_at: new Date(NOW - 11 * H).toISOString() },
        { duty_status: "driving", started_at: new Date(NOW - 8 * H).toISOString() },
        { duty_status: "sleeper", started_at: new Date(NOW - 4 * H).toISOString() },
      ],
      NOW,
    );
    expect(
      pairMeetsRuleD(
        segments,
        { startMs: NOW - 11 * H, endMs: NOW - 8 * H, longestSleeperMs: 0 },
        { startMs: NOW - 4 * H, endMs: NOW + 3 * H, longestSleeperMs: 7 * H },
      ),
    ).toBe(true);
  });
});

describe("formatPlanVerdict", () => {
  it("says plainly when a plan fits, and when it does not", () => {
    const fits = run(
      [ev("Drop the load", 60, 0, { loadStop: "delivery", arriveByMs: NOW + 5 * H })],
      clocks(5, 10),
      [],
      { delivery: { startMs: NOW + 5 * H, endMs: NOW + 5 * H } },
    );
    expect(formatPlanVerdict(fits, NOW)).toContain("fits your hours");
    const missed = run(
      [ev("Drop the load", 240, 0, { loadStop: "delivery", arriveByMs: NOW + 3 * H })],
      clocks(5, 10),
      [],
      { delivery: { startMs: NOW + 3 * H, endMs: NOW + 3 * H } },
    );
    expect(formatPlanVerdict(missed, NOW)).toContain("does not fit");
  });

  it("says out loud when the clocks were assumed full because no duty logs were on file", () => {
    const result = run(
      [ev("Drop the load", 60, 0, { loadStop: "delivery", arriveByMs: NOW + 5 * H })],
      clocks(11, 14),
      [],
      { delivery: { startMs: NOW + 5 * H, endMs: NOW + 5 * H } },
      true,
    );
    expect(formatPlanVerdict(result, NOW)).toContain("No duty logs were on file");
  });
});

describe("segmentsFromLogs", () => {
  it("tiles duty-log rows into segments ending at now", () => {
    const segments = segmentsFromLogs(
      [
        { duty_status: "driving", started_at: new Date(NOW - 2 * H).toISOString() },
        { duty_status: "off_duty", started_at: new Date(NOW - 1 * H).toISOString() },
      ],
      NOW,
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ status: "driving", startMs: NOW - 2 * H, endMs: NOW - 1 * H });
    expect(segments[1]).toMatchObject({ status: "off_duty", startMs: NOW - 1 * H, endMs: NOW });
  });
});
