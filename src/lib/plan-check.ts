// Abel plan check (owner 2026-11-17): "how does this plan fit my drive
// time / delivery window / the load?" Pure: given the driver's REAL
// clocks (the same snapshot the HUD reads), his duty segments, the
// load's windows, and a plan stated as an ordered list of events, say
// whether the plan fits, doesn't fit, or fits with a split sleeper
// break — and what taking the break buys him.
//
// PAPER-LOG HELPER, NOT AN ELD. Planning arithmetic only: traffic,
// weather, fuel stops and loading time are NOT modelled, and the
// answer says so. The ELD / official log is the legal record.
//
// Split sleeper rule, 49 CFR 395.1(g)(1)(ii)-(iii) as verified against
// the eCFR text 2026-11-17: a pair is one period of at least 7
// consecutive hours in the sleeper berth plus a second period of at
// least 2 consecutive hours (off duty, sleeper, or a combination),
// totalling at least 10 hours, in either order. The 11-hour and
// 14-hour limits are then recalculated from the end of the FIRST
// period, and qualifying rest does not count against the 14. NO fresh
// 11 — only 10 consecutive hours off duty fully resets the 11- and
// 14-hour clocks. (ii)(D): driving immediately before + after EACH
// rest period, added together, must not exceed 11 hours, and must not
// violate the 14-hour limit. This module enforces (ii)(D) itself in
// every split suggestion: the split module's isSplitPair (lib/hos.ts)
// checks shape only, and its (ii)(D) fix lands separately — a plan
// answer must never offer a split the rule would not allow.

import {
  buildSegments,
  drivingSinceBreakMs,
  findShortClockAnchor,
  isRest,
  sumMs,
  type RestPeriod,
  type Segment,
} from "@/lib/hos";
import { easternStamp } from "@/lib/trip-plan";
import type { DutyStatus } from "@/types/entities";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
export const PLAN_DRIVE_LIMIT_MS = 11 * HOUR_MS;
export const PLAN_WINDOW_LIMIT_MS = 14 * HOUR_MS;
export const PLAN_BREAK_AFTER_MS = 8 * HOUR_MS;
export const PLAN_BREAK_MS = 30 * MINUTE_MS;
export const PLAN_RESET_MS = 10 * HOUR_MS;
export const PLAN_SPLIT_LONG_SLEEPER_MS = 7 * HOUR_MS;
export const PLAN_SPLIT_SHORT_REST_MS = 2 * HOUR_MS;

export interface PlanClocks {
  driveLeftMs: number;
  windowLeftMs: number;
  breakDueInMs: number;
  /** Remaining 60/70-hour cycle time, or null when unknown. */
  cycleLeftMs: number | null;
}

export interface PlanEventInput {
  /** What he wants to do, in his words (a label only — never parsed for times). */
  label: string;
  /** Driving minutes to reach this event from the previous point (from a route tool the model already ran — never estimated here). */
  driveMinutes: number;
  /** Minutes stopped at the event (0 for a pass-through). */
  dwellMinutes: number;
  /** The dwell is rest of this kind (counts toward breaks, resets and splits). */
  restKind?: "off_duty" | "sleeper" | null;
  /** Latest arrival, epoch ms (appointment close, or "by 9 PM"). */
  arriveByMs?: number | null;
  /** Earliest arrival, epoch ms (appointment open). */
  arriveAfterMs?: number | null;
  /** This event IS that stop on the active load. */
  loadStop?: "pickup" | "delivery" | null;
  /** Added by the evaluator itself (a break it suggests), not part of what he described. */
  inserted?: boolean;
}

export interface PlanWindows {
  pickup?: { startMs: number; endMs: number } | null;
  delivery?: { startMs: number; endMs: number } | null;
}

export interface PlanTimelineEntry {
  label: string;
  arriveMs: number;
  departMs: number;
  lateMs: number;
  waitMs: number;
  insertedResetMs: number | null;
  insertedBreakMs: number | null;
}

export interface PlanSplitOption {
  /** The first period of the pair (already taken, or a rest in the plan). */
  firstLabel: string;
  firstStartMs: number;
  firstEndMs: number;
  /** The rest in the plan that completes the pair. */
  secondLabel: string;
  secondStartMs: number;
  secondEndMs: number;
  /** What the window looks like after the pair completes. */
  windowMovesToMs: number;
  driveLeftAfterMs: number;
  /** Plain words for the answer. */
  line: string;
}

export interface PlanEvaluation {
  verdict: "fits" | "does-not-fit" | "fits-with-break";
  reasons: string[];
  timeline: PlanTimelineEntry[];
  /** The split that saves the plan — null when it fits as stated, when nothing saves it, or when the saving break is a full 10-hour reset instead of a split (then the reasons say so). */
  splitOption: PlanSplitOption | null;
  driveLeftAfterMs: number;
  windowLeftAfterMs: number;
  /** Arrival at the last event, or null with no events. */
  arrivalMs: number | null;
  /** A 10-hour reset the plan needs (atMs + what it is before), when one was inserted. */
  requiredResets: { atMs: number; beforeLabel: string }[];
  /** The 60/70-hour cycle runs out before the plan ends. */
  cycleShort: boolean;
  /** No duty logs were on file, so the clocks were assumed full — the answer must say so. */
  assumedFullClocks: boolean;
}

function fmtDuration(ms: number): string {
  const mins = Math.round(Math.abs(ms) / MINUTE_MS);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

function hm(ms: number): string {
  return fmtDuration(ms);
}

// ---------------------------------------------------------------------------
// (ii)(D): driving + non-rest elapsed immediately before / after a period.
// Boundaries run back to the previous qualifying rest period (a rest run
// of >= 2h, or a >= 7h sleeper stretch) or the last full >= 10h reset.
// Short rest runs (< 2h) do not reset either count — only the rest time
// itself is left out of the non-rest sum. A walk stops at the first
// qualifying rest run or full reset it meets, or at the end of the list.
// ---------------------------------------------------------------------------

interface RestRun {
  startMs: number;
  endMs: number;
  longestSleeperMs: number;
}

function collectRestRuns(segments: Segment[]): RestRun[] {
  const runs: RestRun[] = [];
  let run: RestRun | null = null;
  let sleeperStart: number | null = null;
  const close = () => {
    if (run) runs.push(run);
    run = null;
    sleeperStart = null;
  };
  for (const seg of segments) {
    if (isRest(seg.status)) {
      if (!run) run = { startMs: seg.startMs, endMs: seg.endMs, longestSleeperMs: 0 };
      run.endMs = seg.endMs;
      if (seg.status === "sleeper") {
        if (sleeperStart === null) sleeperStart = seg.startMs;
        run.longestSleeperMs = Math.max(run.longestSleeperMs, seg.endMs - sleeperStart);
      } else {
        sleeperStart = null;
      }
    } else {
      close();
    }
  }
  close();
  return runs;
}

const runIsBoundary = (r: RestRun): boolean =>
  r.endMs - r.startMs >= PLAN_RESET_MS ||
  r.endMs - r.startMs >= PLAN_SPLIT_SHORT_REST_MS ||
  r.longestSleeperMs >= PLAN_SPLIT_LONG_SLEEPER_MS;

/** Driving + non-rest elapsed in the duty stretch immediately before a rest period. */
function beforePeriod(
  segments: Segment[],
  runs: RestRun[],
  periodStartMs: number,
): { driveMs: number; elapsedMs: number } {
  let driveMs = 0;
  let elapsedMs = 0;
  // Walk backward over the segments that end at or before the period.
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    if (seg.endMs <= periodStartMs && seg.startMs < periodStartMs) {
      // A rest segment: stop at a boundary run, skip a short one.
      if (isRest(seg.status)) {
        const run = runs.find((r) => seg.startMs >= r.startMs && seg.endMs <= r.endMs);
        if (run && runIsBoundary(run)) break;
        continue;
      }
    }
    if (seg.startMs >= periodStartMs) continue;
    const from = seg.startMs;
    const to = Math.min(seg.endMs, periodStartMs);
    if (to <= from) continue;
    if (seg.status === "driving") {
      driveMs += to - from;
      elapsedMs += to - from;
    } else if (!isRest(seg.status)) {
      elapsedMs += to - from;
    }
  }
  return { driveMs, elapsedMs };
}

/** Driving + non-rest elapsed in the duty stretch immediately after a rest period. */
function afterPeriod(
  segments: Segment[],
  runs: RestRun[],
  periodEndMs: number,
  untilMs?: number,
): { driveMs: number; elapsedMs: number } {
  let driveMs = 0;
  let elapsedMs = 0;
  for (const seg of segments) {
    if (seg.endMs <= periodEndMs) continue;
    if (untilMs !== undefined && seg.startMs >= untilMs) break;
    if (isRest(seg.status)) {
      const run = runs.find((r) => seg.startMs >= r.startMs && seg.endMs <= r.endMs);
      if (run && runIsBoundary(run)) break;
      continue;
    }
    const from = Math.max(seg.startMs, periodEndMs);
    const to = untilMs !== undefined ? Math.min(seg.endMs, untilMs) : seg.endMs;
    if (to <= from) continue;
    if (seg.status === "driving") {
      driveMs += to - from;
      elapsedMs += to - from;
    } else {
      elapsedMs += to - from;
    }
  }
  return { driveMs, elapsedMs };
}

/** Does this pair satisfy (ii)(D) for BOTH periods? */
export function pairMeetsRuleD(
  segments: Segment[],
  first: RestPeriod,
  second: RestPeriod,
): boolean {
  const runs = collectRestRuns(segments);
  const checks = [
    { at: "first", before: beforePeriod(segments, runs, first.startMs), after: afterPeriod(segments, runs, first.endMs) },
    { at: "second", before: beforePeriod(segments, runs, second.startMs), after: afterPeriod(segments, runs, second.endMs) },
  ];
  for (const c of checks) {
    if (c.before.driveMs + c.after.driveMs > PLAN_DRIVE_LIMIT_MS) return false;
    if (c.before.elapsedMs + c.after.elapsedMs > PLAN_WINDOW_LIMIT_MS) return false;
  }
  return true;
}

const isLongPeriod = (p: RestPeriod): boolean => p.longestSleeperMs >= PLAN_SPLIT_LONG_SLEEPER_MS;
const periodDurationMs = (p: RestPeriod): number => p.endMs - p.startMs;

/** What a second period must be to pair with this first period: duration + whether it must be sleeper. */
function neededSecond(first: RestPeriod): { durationMs: number; sleeper: boolean } {
  if (isLongPeriod(first)) {
    return { durationMs: Math.max(PLAN_SPLIT_SHORT_REST_MS, PLAN_RESET_MS - periodDurationMs(first)), sleeper: false };
  }
  return { durationMs: Math.max(PLAN_SPLIT_LONG_SLEEPER_MS, PLAN_RESET_MS - periodDurationMs(first)), sleeper: true };
}

function shapeOk(first: RestPeriod, second: RestPeriod): boolean {
  const pairOk = (long: RestPeriod, other: RestPeriod) =>
    isLongPeriod(long) && periodDurationMs(other) >= PLAN_SPLIT_SHORT_REST_MS;
  return (pairOk(first, second) || pairOk(second, first)) && periodDurationMs(first) + periodDurationMs(second) >= PLAN_RESET_MS;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

interface AppliedSplit {
  firstEndMs: number;
  secondEventIndex: number;
  secondDurationMs: number;
}

interface Simulation {
  timeline: PlanTimelineEntry[];
  requiredResets: { atMs: number; beforeLabel: string }[];
  requiredBreaks: { atMs: number; beforeLabel: string }[];
  driveLeftAfterMs: number;
  windowLeftAfterMs: number;
  arrivalMs: number | null;
  cycleShort: boolean;
  simSegments: Segment[];
  resetBeforeSplit: boolean;
  missed: { label: string; byMs: number; lateMs: number }[];
}

function simulate(
  events: PlanEventInput[],
  clocks: PlanClocks,
  nowMs: number,
  priorSegments: Segment[],
  split: AppliedSplit | null,
): Simulation {
  let t = nowMs;
  let driveLeft = clocks.driveLeftMs;
  let windowLeft = clocks.windowLeftMs;
  let breakDueIn = clocks.breakDueInMs;
  let cycleLeft = clocks.cycleLeftMs;
  const timeline: PlanTimelineEntry[] = [];
  const requiredResets: { atMs: number; beforeLabel: string }[] = [];
  const requiredBreaks: { atMs: number; beforeLabel: string }[] = [];
  const missed: { label: string; byMs: number; lateMs: number }[] = [];
  const simSegments: Segment[] = [];
  let cycleShort = false;
  let resetBeforeSplit = false;
  // Continuous rest so far (off duty / sleeper with no driving or
  // on-duty time between dwells). A run of 10 hours is a full reset,
  // even when it spans two dwells (a 2-hour break then 8 hours in the
  // sleeper is 10 hours off duty in a row).
  let restRunMs = 0;

  const record = (status: DutyStatus, fromMs: number, toMs: number) => {
    if (toMs > fromMs) simSegments.push({ status, startMs: fromMs, endMs: toMs });
  };

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    let remaining = Math.max(0, Math.round(ev.driveMinutes * MINUTE_MS));
    let insertedResetMs: number | null = null;
    let insertedBreakMs: number | null = null;

    while (remaining > 0) {
      if (cycleLeft !== null && cycleLeft <= 0) {
        cycleShort = true;
        remaining = 0;
        break;
      }
      if (driveLeft <= 0 || windowLeft <= 0) {
        if (split && i <= split.secondEventIndex) resetBeforeSplit = true;
        insertedResetMs = t;
        requiredResets.push({ atMs: t, beforeLabel: ev.label });
        record("off_duty", t, t + PLAN_RESET_MS);
        restRunMs += PLAN_RESET_MS;
        t += PLAN_RESET_MS;
        driveLeft = PLAN_DRIVE_LIMIT_MS;
        windowLeft = PLAN_WINDOW_LIMIT_MS;
        breakDueIn = PLAN_BREAK_AFTER_MS;
        continue;
      }
      if (breakDueIn <= 0) {
        insertedBreakMs = t;
        requiredBreaks.push({ atMs: t, beforeLabel: ev.label });
        record("off_duty", t, t + PLAN_BREAK_MS);
        restRunMs += PLAN_BREAK_MS;
        t += PLAN_BREAK_MS;
        windowLeft -= PLAN_BREAK_MS;
        breakDueIn = PLAN_BREAK_AFTER_MS;
        continue;
      }
      const chunk = Math.min(remaining, driveLeft, windowLeft, breakDueIn, cycleLeft ?? Number.POSITIVE_INFINITY);
      if (chunk <= 0) {
        // Cycle is the binding limit and it is spent.
        cycleShort = true;
        remaining = 0;
        break;
      }
      record("driving", t, t + chunk);
      restRunMs = 0;
      t += chunk;
      remaining -= chunk;
      driveLeft -= chunk;
      windowLeft -= chunk;
      breakDueIn -= chunk;
      if (cycleLeft !== null) cycleLeft -= chunk;
    }

    const arriveMs = t;
    let waitMs = 0;
    if (ev.arriveAfterMs != null && t < ev.arriveAfterMs) {
      waitMs = ev.arriveAfterMs - t;
      record("on_duty", t, ev.arriveAfterMs);
      restRunMs = 0;
      t = ev.arriveAfterMs;
      windowLeft -= waitMs;
    }
    let lateMs = 0;
    if (ev.arriveByMs != null && t > ev.arriveByMs) {
      lateMs = t - ev.arriveByMs;
      missed.push({ label: ev.label, byMs: ev.arriveByMs, lateMs });
    }

    const departMs = t + Math.max(0, ev.dwellMinutes * MINUTE_MS);
    if (ev.dwellMinutes > 0) {
      const status: DutyStatus = ev.restKind ?? "on_duty";
      record(status, t, departMs);
      const dwellMs = departMs - t;
      if (ev.restKind) {
        // Rest consumes the window (only a completed split pair's
        // second period is excluded, applied below) — a short rest
        // does not pause the 14-hour window.
        windowLeft -= dwellMs;
        restRunMs += dwellMs;
        if (restRunMs >= PLAN_RESET_MS) {
          // A full 10 hours off duty in a row restores everything —
          // even when the run spans two dwells.
          driveLeft = PLAN_DRIVE_LIMIT_MS;
          windowLeft = PLAN_WINDOW_LIMIT_MS;
          breakDueIn = PLAN_BREAK_AFTER_MS;
        } else if (dwellMs >= PLAN_BREAK_MS) {
          breakDueIn = PLAN_BREAK_AFTER_MS;
        }
      } else {
        restRunMs = 0;
        windowLeft -= dwellMs;
      }
      // Split applied: the pair completes at the end of this dwell.
      // (A 10-hour rest run already fully resets the clocks above,
      // which is strictly better than a split — never overwrite it.)
      if (split && i === split.secondEventIndex && ev.restKind && restRunMs < PLAN_RESET_MS) {
        const all = [...priorSegments, ...simSegments];
        const driveUsed = sumMs(all, split.firstEndMs, departMs, ["driving"]);
        const windowElapsed = Math.max(0, departMs - split.firstEndMs - split.secondDurationMs);
        driveLeft = Math.max(0, PLAN_DRIVE_LIMIT_MS - driveUsed);
        windowLeft = Math.max(0, PLAN_WINDOW_LIMIT_MS - windowElapsed);
        breakDueIn = Math.max(0, PLAN_BREAK_AFTER_MS - drivingSinceBreakMs(all, split.firstEndMs, departMs));
      }
      t = departMs;
    }

    timeline.push({ label: ev.label, arriveMs, departMs, lateMs, waitMs, insertedResetMs, insertedBreakMs });
  }

  return {
    timeline,
    requiredResets,
    requiredBreaks,
    driveLeftAfterMs: Math.max(0, driveLeft),
    windowLeftAfterMs: Math.max(0, windowLeft),
    arrivalMs: timeline.length > 0 ? timeline[timeline.length - 1]!.arriveMs : null,
    cycleShort,
    simSegments,
    resetBeforeSplit,
    missed,
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface EvaluatePlanInput {
  events: PlanEventInput[];
  clocks: PlanClocks;
  /** Duty segments up to now (from the same HOS snapshot as the clocks). */
  segments: Segment[];
  windows: PlanWindows;
  nowMs: number;
  assumedFullClocks: boolean;
}

// ---------------------------------------------------------------------------
// Rest runs in a plan: adjacent rest dwells with no driving between
// them are ONE continuous run — one period, not two — following
// lib/hos.ts (collectRestRuns). A run's longest sleeper stretch is
// tracked the same way, so a 2-hour off-duty break followed at once
// by 8 hours in the sleeper is one 10-hour run (a full reset), not a
// split pair. Whether such a mixed run counts as one combination
// period or two periods is open in the rule; treating it as one run
// is the conservative reading, and a 10-hour run resets fully either
// way.
// ---------------------------------------------------------------------------

interface PlanRestRun {
  period: RestPeriod;
  label: string;
  /** Index of the event where the run ends (where a split applies). */
  lastIndex: number;
  inserted: boolean;
}

function planRestRuns(events: PlanEventInput[], timeline: PlanTimelineEntry[]): PlanRestRun[] {
  const runs: PlanRestRun[] = [];
  let current: PlanRestRun | null = null;
  let sleeperStart: number | null = null;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (!ev.restKind || ev.dwellMinutes <= 0) {
      current = null;
      sleeperStart = null;
      continue;
    }
    const startMs = timeline[i]!.departMs - ev.dwellMinutes * MINUTE_MS;
    const endMs = timeline[i]!.departMs;
    const continues = current !== null && ev.driveMinutes === 0;
    if (!continues || !current) {
      current = {
        period: { startMs, endMs, longestSleeperMs: 0 },
        label: ev.label,
        lastIndex: i,
        inserted: ev.inserted === true,
      };
      runs.push(current);
      sleeperStart = null;
    } else {
      current.period.endMs = endMs;
      current.label = ev.label;
      current.lastIndex = i;
      current.inserted = current.inserted || ev.inserted === true;
    }
    if (ev.restKind === "sleeper") {
      if (sleeperStart === null) sleeperStart = startMs;
      current.period.longestSleeperMs = Math.max(current.period.longestSleeperMs, endMs - sleeperStart);
    } else {
      sleeperStart = null;
    }
  }
  return runs;
}

function evaluatePlanInner(input: EvaluatePlanInput, allowInsert: boolean): PlanEvaluation {
  const { events, clocks, segments, windows, nowMs } = input;
  const base = simulate(events, clocks, nowMs, segments, null);

  const reasons: string[] = [];
  const windowMisses: { label: string; byMs: number; lateMs: number }[] = [...base.missed];

  // Load-window checks on the events that ARE load stops (the tool
  // fills their arrive-by from the load's real appointments). When the
  // event already carries that same appointment as its arrive-by, the
  // miss is already counted above — say it once, not twice.
  for (const entry of base.timeline) {
    const ev = events[base.timeline.indexOf(entry)]!;
    if (ev.loadStop === "delivery" && windows.delivery && ev.arriveByMs !== windows.delivery.endMs) {
      if (entry.arriveMs > windows.delivery.endMs) {
        windowMisses.push({ label: `${ev.label} (delivery)`, byMs: windows.delivery.endMs, lateMs: entry.arriveMs - windows.delivery.endMs });
      }
    }
    if (ev.loadStop === "pickup" && windows.pickup && ev.arriveByMs !== windows.pickup.endMs) {
      if (entry.arriveMs > windows.pickup.endMs) {
        windowMisses.push({ label: `${ev.label} (pickup)`, byMs: windows.pickup.endMs, lateMs: entry.arriveMs - windows.pickup.endMs });
      }
    }
  }

  const fitsAsIs = windowMisses.length === 0 && !base.cycleShort;

  if (fitsAsIs) {
    if (base.requiredResets.length > 0) {
      for (const r of base.requiredResets) {
        reasons.push(`It fits, but you need a 10-hour reset at ${easternStamp(r.atMs)} before ${r.beforeLabel} — a full 10 hours off duty is the only thing that gives you fresh 11 driving hours.`);
      }
    }
    if (base.requiredBreaks.length > 0) {
      reasons.push(`A 30-minute break is due on the way (after 8 hours of driving) — it is already in the plan.`);
    }
    return {
      verdict: "fits",
      reasons,
      timeline: base.timeline,
      splitOption: null,
      driveLeftAfterMs: base.driveLeftAfterMs,
      windowLeftAfterMs: base.windowLeftAfterMs,
      arrivalMs: base.arrivalMs,
      requiredResets: base.requiredResets,
      cycleShort: false,
      assumedFullClocks: input.assumedFullClocks,
    };
  }

  // It does not fit as stated. Try a split break: a pending first
  // period from the real logs, or a rest in the plan itself as the
  // first period, paired with a later rest in the plan.
  const anchor = findShortClockAnchor(segments);
  const firstCandidates: { period: RestPeriod; label: string; fromPlan: boolean; inserted: boolean }[] = [];
  if (anchor?.pending) {
    firstCandidates.push({ period: anchor.pending.period, label: "the rest you already took", fromPlan: false, inserted: false });
  }
  // A rest run in the plan can be the first period too.
  const runs = planRestRuns(events, base.timeline);
  for (const run of runs) {
    if (periodDurationMs(run.period) < PLAN_SPLIT_SHORT_REST_MS) continue;
    firstCandidates.push({ period: run.period, label: run.label, fromPlan: true, inserted: run.inserted });
  }

  for (const first of firstCandidates) {
    const need = neededSecond(first.period);
    // Candidate second periods: rest runs after the first period ends.
    for (const run of runs) {
      const second = run.period;
      if (second.startMs <= first.period.endMs) continue;
      if (need.sleeper && second.longestSleeperMs < PLAN_SPLIT_LONG_SLEEPER_MS) continue;
      if (periodDurationMs(second) < need.durationMs) continue;
      if (!shapeOk(first.period, second)) continue;
      // (ii)(D) on the real logs + the plan's own timeline.
      const allSegments = [...segments, ...base.simSegments];
      if (!pairMeetsRuleD(allSegments, first.period, second)) continue;
      // Re-simulate with the split applied at this rest.
      const splitSim = simulate(events, clocks, nowMs, segments, {
        firstEndMs: first.period.endMs,
        secondEventIndex: run.lastIndex,
        secondDurationMs: second.endMs - second.startMs,
      });
      if (splitSim.resetBeforeSplit) continue;
      const splitMisses = [...splitSim.missed];
      for (const entry of splitSim.timeline) {
        const e = events[splitSim.timeline.indexOf(entry)]!;
        if (e.loadStop === "delivery" && windows.delivery && e.arriveByMs !== windows.delivery.endMs && entry.arriveMs > windows.delivery.endMs) {
          splitMisses.push({ label: `${e.label} (delivery)`, byMs: windows.delivery.endMs, lateMs: entry.arriveMs - windows.delivery.endMs });
        }
        if (e.loadStop === "pickup" && windows.pickup && e.arriveByMs !== windows.pickup.endMs && entry.arriveMs > windows.pickup.endMs) {
          splitMisses.push({ label: `${e.label} (pickup)`, byMs: windows.pickup.endMs, lateMs: entry.arriveMs - windows.pickup.endMs });
        }
      }
      if (splitMisses.length === 0 && !splitSim.cycleShort) {
        const firstDurationMs = first.period.endMs - first.period.startMs;
        const secondDurationMs = second.endMs - second.startMs;
        const windowMovesToMs = first.period.endMs + PLAN_WINDOW_LIMIT_MS + secondDurationMs;
        const explainer =
          `A split sleeper break is two rests adding to 10 hours — one at least 7 hours in the sleeper, one at least 2 hours off — which moves your window instead of resetting it; only a full 10 hours off duty gives you fresh 11 driving hours.`;
        const secondInserted = run.inserted;
        const secondKind = second.longestSleeperMs >= PLAN_SPLIT_LONG_SLEEPER_MS ? "sleeper" : "off-duty";
        const line = first.inserted
          ? `Take a ${hm(firstDurationMs)} break ${first.label} — it pairs with your ${hm(secondDurationMs)} at ${run.label} for 10 hours total, so your 14-hour window moves to ${easternStamp(windowMovesToMs)} and you finish with ${hm(splitSim.driveLeftAfterMs)} of drive time left. ${explainer}`
          : secondInserted
            ? `Take a ${hm(secondDurationMs)} ${secondKind} break ${run.label} — it pairs with ${first.label} (${hm(firstDurationMs)}) for 10 hours total, so your 14-hour window moves to ${easternStamp(windowMovesToMs)} and you finish with ${hm(splitSim.driveLeftAfterMs)} of drive time left. ${explainer}`
            : `Take a split sleeper break of ${hm(secondDurationMs)} at ${run.label} — that pairs with ${first.label} (${hm(firstDurationMs)}) for 10 hours total, so your 14-hour window moves to ${easternStamp(windowMovesToMs)} and you finish with ${hm(splitSim.driveLeftAfterMs)} of drive time left. ${explainer}`;
        const option: PlanSplitOption = {
          firstLabel: first.label,
          firstStartMs: first.period.startMs,
          firstEndMs: first.period.endMs,
          secondLabel: run.label,
          secondStartMs: second.startMs,
          secondEndMs: second.endMs,
          windowMovesToMs,
          driveLeftAfterMs: splitSim.driveLeftAfterMs,
          line,
        };
        return {
          verdict: "fits-with-break",
          reasons: [
            `As stated it does not fit${windowMisses.map((m) => ` — you would be ${hm(m.lateMs)} late for ${m.label}`).join("")}${base.cycleShort ? " — your 60/70-hour cycle runs out first (a split does not touch the cycle; only a 34-hour restart resets it)" : ""}.`,
            option.line,
          ],
          timeline: splitSim.timeline,
          splitOption: option,
          driveLeftAfterMs: splitSim.driveLeftAfterMs,
          windowLeftAfterMs: splitSim.windowLeftAfterMs,
          arrivalMs: splitSim.arrivalMs,
          requiredResets: splitSim.requiredResets,
          cycleShort: false,
          assumedFullClocks: input.assumedFullClocks,
        };
      }
    }
  }

  // One more save: add a single rest — a 2-hour break or a 7-hour
  // sleeper break — before any stop, and see if the pair completes
  // with a rest the plan already has (or one he already took). Depth
  // one: the recursive call does not insert again.
  if (allowInsert) {
    for (let pos = 0; pos < events.length; pos++) {
      const next = events[pos]!;
      for (const ins of [
        { dwellMinutes: 120, restKind: "off_duty" as const },
        { dwellMinutes: 420, restKind: "sleeper" as const },
      ]) {
        const inserted: PlanEventInput = {
          label: `before ${next.label}`,
          driveMinutes: 0,
          dwellMinutes: ins.dwellMinutes,
          restKind: ins.restKind,
          inserted: true,
        };
        const modified = [...events.slice(0, pos), inserted, ...events.slice(pos)];
        const found = evaluatePlanInner({ ...input, events: modified }, false);
        if (found.verdict === "fits-with-break") return found;
        if (found.verdict === "fits") {
          // The added break made it fit as a full 10-hour reset, not
          // a split: the break plus a rest already in the plan runs
          // 10 hours off duty in a row. That is better than a split
          // (fresh 11 driving hours) — say so plainly.
          const late = windowMisses.map((m) => ` — you would be ${hm(m.lateMs)} late for ${m.label}`).join("");
          return {
            ...found,
            verdict: "fits-with-break",
            splitOption: null,
            reasons: [
              `As stated it does not fit${late}${base.cycleShort ? " — your 60/70-hour cycle runs out first (a split does not touch the cycle; only a 34-hour restart resets it)" : ""}.`,
              `Take a ${hm(ins.dwellMinutes * MINUTE_MS)} break ${inserted.label} — with the rest already in the plan that is 10 hours off duty in a row, a full reset, so you start with fresh 11 driving hours and a fresh 14-hour window. Only a full 10 hours off duty gives you fresh 11 driving hours; a split sleeper break only moves the window.`,
            ],
          };
        }
      }
    }
  }

  // No split saves it.
  for (const m of windowMisses) {
    reasons.push(`You would be ${hm(m.lateMs)} late for ${m.label} (due ${easternStamp(m.byMs)}, arriving ${easternStamp(m.byMs + m.lateMs)}).`);
  }
  if (base.cycleShort) {
    reasons.push("Your 60/70-hour cycle runs out before the plan ends — a split sleeper break does not touch the cycle; only a 34-hour restart resets it.");
  }
  if (base.requiredResets.length > 0) {
    for (const r of base.requiredResets) {
      reasons.push(`You would need a 10-hour reset at ${easternStamp(r.atMs)} before ${r.beforeLabel}.`);
    }
  }
  if (reasons.length === 0) {
    reasons.push("The plan does not fit your hours as stated, and no split sleeper break fixes it.");
  }
  return {
    verdict: "does-not-fit",
    reasons,
    timeline: base.timeline,
    splitOption: null,
    driveLeftAfterMs: base.driveLeftAfterMs,
    windowLeftAfterMs: base.windowLeftAfterMs,
    arrivalMs: base.arrivalMs,
    requiredResets: base.requiredResets,
    cycleShort: base.cycleShort,
    assumedFullClocks: input.assumedFullClocks,
  };
}

/** The public entry: one insertion of a suggested break is allowed. */
export function evaluatePlan(input: EvaluatePlanInput): PlanEvaluation {
  return evaluatePlanInner(input, true);
}

/** The verdict in plain words, with the numbers as support. Times are Eastern. */
export function formatPlanVerdict(evaluation: PlanEvaluation, nowMs: number): string {
  const lines: string[] = [];
  if (evaluation.verdict === "fits") {
    lines.push(`✅ That plan fits your hours.`);
  } else if (evaluation.verdict === "fits-with-break") {
    lines.push(`✅ That plan fits — with a split sleeper break.`);
  } else {
    lines.push(`❌ That plan does not fit your hours as stated.`);
  }
  for (const r of evaluation.reasons) lines.push(r);
  if (evaluation.arrivalMs !== null) {
    lines.push(`You finish at ${easternStamp(evaluation.arrivalMs)} (${fmtDuration(evaluation.arrivalMs - nowMs)} from now), with ${fmtDuration(evaluation.driveLeftAfterMs)} of drive time and ${fmtDuration(evaluation.windowLeftAfterMs)} of your 14-hour window left.`);
  }
  if (evaluation.assumedFullClocks) {
    lines.push("No duty logs were on file, so this assumes you start with full hours (11 driving / 14 window) — log your duty and the numbers get real.");
  }
  lines.push("Planning arithmetic only: traffic, weather, fuel stops, loading and unloading time are not included — add a buffer. The ELD / official log is the legal record, not this helper.");
  return lines.join("\n");
}

/** Build duty segments for the evaluator from duty-log rows (same tiling as the HOS engine). */
export function segmentsFromLogs(
  logs: { duty_status: DutyStatus; started_at: string }[],
  nowMs: number,
): Segment[] {
  return buildSegments(logs, nowMs);
}
