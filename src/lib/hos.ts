// Driver MVP (docs/design/driver-mvp.md §3). Warn-only hours-of-service
// summaries computed from duty_logs rows.
//
// PAPER-LOG HELPER, NOT AN ELD. These numbers come from what the driver
// manually logged in this app; they are never certified, never block
// anything, and never replace the truck's ELD or official paper logs,
// which remain the legal record. The job of this file is only to warn
// early enough that the driver can plan - the same reason it's worth
// unit-testing: a wrong warning (in either direction) is a real-world
// problem, not a cosmetic one.
//
// SHORT-TERM CLOCKS ONLY (11h driving / 14h window / 30-minute
// break). The weekly cycle - 60/7 vs 70/8, period boundaries, and the
// 34-hour restart - lives in ONE place, lib/hos-cycle.ts, and every
// surface reads it from the same window snapshot
// (services/api/hos-window.ts). This file used to compute its own
// rolling 8-day, hardcoded-70-hour cycle figure; that second engine
// disagreed with the cycle engine after a restart and under 60/7, so
// it was retired (federal compliance audit §6 item #5, 2026-11-14).
// Shared segment helpers (buildSegments, sumMs, findWindowStartMs,
// drivingSinceBreakMs) stay here because both engines tile the same
// status-start event sequence.

import type { DutyStatus } from "@/types/entities";

export interface DutySegmentInput {
  duty_status: DutyStatus;
  started_at: string;
}

export interface HosSummary {
  /** ISO start of the current 14-hour window, or null with no logs. */
  windowStart: string | null;
  drivingMinutesInWindow: number;
  windowElapsedMinutes: number;
  drivingMinutesSinceBreak: number;
  warnings: string[];
}

const MINUTE_MS = 60_000;
const DRIVING_LIMIT_MIN = 11 * 60;
const WINDOW_LIMIT_MIN = 14 * 60;
const BREAK_REQUIRED_AFTER_MIN = 8 * 60;
const BREAK_LENGTH_MIN = 30;
const RESET_REST_MIN = 10 * 60;

// Segment construction is shared with the settings-anchored cycle
// engine (lib/hos-cycle.ts, Reliability Unit B): both engines read the
// same status-start event sequence, so the tiling must not diverge.
export interface Segment {
  status: DutyStatus;
  startMs: number;
  endMs: number;
}

export function buildSegments(logs: DutySegmentInput[], nowMs: number): Segment[] {
  const sorted = [...logs]
    .map((log) => ({ status: log.duty_status, startMs: new Date(log.started_at).getTime() }))
    .filter((log) => Number.isFinite(log.startMs) && log.startMs <= nowMs)
    .sort((a, b) => a.startMs - b.startMs);

  return sorted.map((log, i) => ({
    status: log.status,
    startMs: log.startMs,
    endMs: sorted[i + 1]?.startMs ?? nowMs,
  }));
}

export function isRest(status: DutyStatus): boolean {
  return status === "off_duty" || status === "sleeper";
}

/** Exact milliseconds spent in the given statuses inside [fromMs, toMs]. */
export function sumMs(
  segments: Segment[],
  fromMs: number,
  toMs: number,
  statuses: DutyStatus[],
): number {
  let total = 0;
  for (const seg of segments) {
    if (!statuses.includes(seg.status)) continue;
    const start = Math.max(seg.startMs, fromMs);
    const end = Math.min(seg.endMs, toMs);
    if (end > start) total += end - start;
  }
  return total;
}

export function sumMinutes(
  segments: Segment[],
  fromMs: number,
  toMs: number,
  statuses: DutyStatus[],
): number {
  return Math.round(sumMs(segments, fromMs, toMs, statuses) / MINUTE_MS);
}

// ---- Split sleeper berth (owner 2026-11-17; docs/design/split-sleeper.md) ------------------------------
// Federal rule for property-carrying drivers, 49 CFR 395.1(g)(1)(ii) as amended in 2020 (built from the rule as
// published; NOT yet re-checked against the eCFR text from this environment - see the design doc):
//  - one period of at least 7 CONSECUTIVE hours in the SLEEPER BERTH, and
//  - a separate period of at least 2 consecutive hours off duty, in the sleeper berth, or both,
//  - together totaling at least 10 hours, in either order.
//  - (ii)(D): for EACH of the two periods, the driving immediately before it plus the driving immediately
//    after it must not exceed 11 hours, and the non-rest time immediately before it plus immediately after
//    it must not exceed 14 hours. A pair that fails (D) for either period does not qualify at all.
// Paired, neither period counts against the 14-hour window, and the 11- and 14-hour limits are figured from the
// END OF THE FIRST of the two periods. Pairs chain: the second period of one pair can be the first of the next.

export const SPLIT_LONG_SLEEPER_MIN = 7 * 60;
export const SPLIT_SHORT_REST_MIN = 2 * 60;

/** One continuous stretch of off-duty/sleeper time shorter than a full 10-hour reset. */
export interface RestPeriod {
  startMs: number;
  endMs: number;
  /** Longest unbroken sleeper-berth stretch inside it. */
  longestSleeperMs: number;
}

export interface ShortClockAnchor {
  /** Where the 11- and 14-hour clocks are figured from. */
  startMs: number;
  /** Rest time after startMs that does NOT count against the 14-hour window (the paired second period). */
  excludedMs: number;
  /** The split pair in use, or null when the clocks run from a full 10-hour reset (or the first log). */
  split: { first: RestPeriod; second: RestPeriod } | null;
  /** A qualifying period with no partner yet (what he still needs, in plain words), or null. */
  pending: { period: RestPeriod; needs: string } | null;
}

const isLong = (p: RestPeriod) => p.longestSleeperMs >= SPLIT_LONG_SLEEPER_MIN * MINUTE_MS;
const durMs = (p: RestPeriod) => p.endMs - p.startMs;
const qualifies = (p: RestPeriod) => isLong(p) || durMs(p) >= SPLIT_SHORT_REST_MIN * MINUTE_MS;

/** Do these two periods (in either order) make a legal split on SHAPE alone (long/short/total)?
 * (ii)(D) needs the surrounding timeline, so it is checked separately in findShortClockAnchor
 * via periodMeetsRuleD — a pair that passes this shape check can still fail (D). */
export function isSplitPair(a: RestPeriod, b: RestPeriod): boolean {
  const pairOk = (long: RestPeriod, other: RestPeriod) => isLong(long) && durMs(other) >= SPLIT_SHORT_REST_MIN * MINUTE_MS;
  return (pairOk(a, b) || pairOk(b, a)) && durMs(a) + durMs(b) >= RESET_REST_MIN * MINUTE_MS;
}

/**
 * 49 CFR 395.1(g)(1)(ii)(D), for ONE period of a candidate pair: the driving immediately before the period
 * plus the driving immediately after it must not exceed 11 hours, and the non-rest time immediately before
 * it plus immediately after it must not exceed 14 hours.
 *
 * "Immediately before" runs back to the previous qualifying rest period (or the last full reset); "immediately
 * after" runs forward to the next qualifying rest period (or now). Short breaks in between do not reset either
 * count — only rest time itself is left out of the non-rest sum, because a short break does not pause the
 * 14-hour clock and does not reset accumulated driving. Both halves are checked for BOTH periods of the pair.
 */
export function periodMeetsRuleD(
  p: RestPeriod,
  segments: Segment[],
  beforeMs: number,
  afterMs: number,
): boolean {
  const NON_REST: DutyStatus[] = ["driving", "on_duty"];
  const driveBefore = sumMs(segments, beforeMs, p.startMs, ["driving"]);
  const driveAfter = sumMs(segments, p.endMs, afterMs, ["driving"]);
  if (driveBefore + driveAfter > DRIVING_LIMIT_MIN * MINUTE_MS) return false;
  const dutyBefore = sumMs(segments, beforeMs, p.startMs, NON_REST);
  const dutyAfter = sumMs(segments, p.endMs, afterMs, NON_REST);
  return dutyBefore + dutyAfter <= WINDOW_LIMIT_MIN * MINUTE_MS;
}

function hm(ms: number): string {
  const m = Math.max(0, Math.ceil(ms / MINUTE_MS));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Where the short clocks run from, split sleeper included. A full >=10-hour rest resets the 11- and 14-hour
 * clocks (as before) — it does NOT reset the 60/70-hour limit; only a 34+ hour restart does that (§ 395.3(c)).
 * After it, qualifying rest periods are paired in order and each completed pair moves the anchor to the end of
 * its first period, with its second period excluded from the 14-hour window. A pair only counts if it also
 * passes (ii)(D) for both periods (periodMeetsRuleD); a pair that fails (D) leaves the anchor where it was.
 *
 * Day-aware reset (opts.dayStartMs, owner 2026-11-17): a hand reset re-derives the anchor from the log of the
 * day starting here - rest periods and full-reset bases from before that day are dropped, the anchor starts at
 * the day's first duty, and everything from that day still counts (driving, on-duty, breaks, and a pending
 * split first period). (ii)(D) is then evaluated on that day's log only. With no duty logged that day yet the
 * option does nothing and the normal derivation stands.
 */
export function findShortClockAnchor(
  segments: Segment[],
  opts: { dayStartMs?: number | null } = {},
): ShortClockAnchor | null {
  if (segments.length === 0) return null;
  const resetMs = RESET_REST_MIN * MINUTE_MS;
  // Day-aware reset (owner 2026-11-17): when the driver resets his
  // clocks by hand, the anchor is re-derived from TODAY's log from
  // scratch - a stale anchor carried over from before today is
  // dropped, but everything today still counts (driving, on-duty,
  // breaks, and any pending split first period). The floor only
  // applies when he has actually gone on duty today; with no duty
  // today yet there is nothing to re-derive from, so the normal
  // derivation stands.
  const floorMs = opts.dayStartMs ?? null;
  const hasDutyToday =
    floorMs !== null && segments.some((seg) => !isRest(seg.status) && seg.endMs > floorMs);
  const dayAware = floorMs !== null && hasDutyToday;
  let base = dayAware
    ? Math.max(
        segments.find((seg) => !isRest(seg.status) && seg.endMs > floorMs!)!.startMs,
        floorMs!,
      )
    : segments[0]!.startMs;
  const periods: RestPeriod[] = [];
  let run: RestPeriod | null = null;
  let sleeperRunStart: number | null = null;
  const close = () => {
    if (!run) return;
    // Before today a run neither resets the base nor pairs - the
    // reset drops it from the derivation entirely.
    if (dayAware && run.endMs < floorMs!) {
      run = null;
      return;
    }
    if (durMs(run) >= resetMs) {
      base = run.endMs;
      periods.length = 0;
    } else if (qualifies(run)) {
      periods.push(run);
    }
    run = null;
  };
  for (const seg of segments) {
    if (isRest(seg.status)) {
      if (!run) run = { startMs: seg.startMs, endMs: seg.endMs, longestSleeperMs: 0 };
      run.endMs = seg.endMs;
      if (seg.status === "sleeper") {
        if (sleeperRunStart === null) sleeperRunStart = seg.startMs;
        run.longestSleeperMs = Math.max(run.longestSleeperMs, seg.endMs - sleeperRunStart);
      } else {
        sleeperRunStart = null;
      }
    } else {
      sleeperRunStart = null;
      close();
    }
  }
  // A rest still running counts with the time so far (a reset in progress, or a period that already qualifies).
  close();
  periods.sort((a, b) => a.startMs - b.startMs);
  // Day-aware: periods are already gated to those ending today (in
  // close()), including one that started before today's first duty
  // segment - a night's rest straddling midnight is still today's
  // first period. Otherwise periods before the base do not count.
  const relevant = dayAware ? periods : periods.filter((p) => p.startMs >= base);

  let anchor: ShortClockAnchor = { startMs: base, excludedMs: 0, split: null, pending: null };
  const nowMs = segments[segments.length - 1]!.endMs;
  for (let i = 0; i + 1 < relevant.length; i++) {
    const first = relevant[i]!;
    const second = relevant[i + 1]!;
    // (ii)(D) boundaries: back to the previous qualifying period (or the last full reset), forward to the
    // next qualifying period (or now). The first period's "after" is its partner; the second period's
    // "before" is the first period.
    const firstBeforeMs = i > 0 ? relevant[i - 1]!.endMs : base;
    const secondAfterMs = i + 2 < relevant.length ? relevant[i + 2]!.startMs : nowMs;
    if (
      isSplitPair(first, second) &&
      periodMeetsRuleD(first, segments, firstBeforeMs, second.startMs) &&
      periodMeetsRuleD(second, segments, first.endMs, secondAfterMs)
    ) {
      anchor = { startMs: first.endMs, excludedMs: durMs(second), split: { first, second }, pending: null };
    }
  }
  const last = relevant[relevant.length - 1];
  if (last && (!anchor.split || anchor.split.second !== last)) {
    const needs = isLong(last)
      ? `at least ${hm(Math.max(SPLIT_SHORT_REST_MIN * MINUTE_MS, resetMs - durMs(last)))} more off duty or in the sleeper (in one stretch) to pair it`
      : `at least ${hm(Math.max(SPLIT_LONG_SLEEPER_MIN * MINUTE_MS, resetMs - durMs(last)))} in the sleeper berth (in one stretch) to pair it`;
    anchor = { ...anchor, pending: { period: last, needs } };
  }
  return anchor;
}

/**
 * The current 14-hour window starts when a continuous >=10-hour
 * off_duty/sleeper rest ends. If no such rest exists in the logs, the
 * window is taken to start at the earliest log - honest, because the
 * helper only knows what was logged in it.
 */
export function findWindowStartMs(segments: Segment[]): number | null {
  // Split sleeper (2026-11-17): the anchor moves to the end of the first period of a completed pair.
  return findShortClockAnchor(segments)?.startMs ?? null;
}

/** The pre-split rule only (a full 10-hour rest), kept for the reset display. */
export function findFullResetStartMs(segments: Segment[]): number | null {
  if (segments.length === 0) return null;

  let windowStart = segments[0]!.startMs;
  let restRunStart: number | null = null;

  for (const seg of segments) {
    if (isRest(seg.status)) {
      if (restRunStart === null) restRunStart = seg.startMs;
      if (seg.endMs - restRunStart >= RESET_REST_MIN * MINUTE_MS) {
        windowStart = seg.endMs;
      }
    } else {
      restRunStart = null;
    }
  }
  return windowStart;
}

/**
 * Driving since the last qualifying break. Any continuous >=30 minutes
 * of non-driving status (off duty, sleeper, or on-duty-not-driving)
 * counts as the break, per the federal rule. Returns driving minutes
 * accumulated after that break ended (or since the window start if no
 * break has happened yet).
 */
export function drivingSinceBreakMs(segments: Segment[], windowStartMs: number, nowMs: number): number {
  let breakEndMs = windowStartMs;
  let nonDrivingRunStart: number | null = null;

  for (const seg of segments) {
    if (seg.startMs < windowStartMs) continue;
    if (seg.status !== "driving") {
      if (nonDrivingRunStart === null) nonDrivingRunStart = Math.max(seg.startMs, windowStartMs);
      if (seg.endMs - nonDrivingRunStart >= BREAK_LENGTH_MIN * MINUTE_MS) {
        breakEndMs = seg.endMs;
      }
    } else {
      nonDrivingRunStart = null;
    }
  }
  return sumMs(segments, breakEndMs, nowMs, ["driving"]);
}

function drivingSinceBreakMinutes(segments: Segment[], windowStartMs: number, nowMs: number): number {
  return Math.round(drivingSinceBreakMs(segments, windowStartMs, nowMs) / MINUTE_MS);
}

function formatHours(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * What today already holds, for the reset confirm sheet (owner
 * 2026-11-17): the reset re-derives the clocks from today's real
 * log, so the sheet shows what it counted - driving and on-duty time
 * today, and the breaks (continuous 30+ minute non-driving stops)
 * taken today. Pure.
 */
export interface DaySoFar {
  drivenMs: number;
  onDutyMs: number;
  breakCount: number;
  breakTotalMs: number;
}

export function summarizeDaySoFar(segments: Segment[], dayStartMs: number, nowMs: number): DaySoFar {
  const drivenMs = sumMs(segments, dayStartMs, nowMs, ["driving"]);
  const onDutyMs = sumMs(segments, dayStartMs, nowMs, ["driving", "on_duty"]);
  let breakCount = 0;
  let breakTotalMs = 0;
  let runStart: number | null = null;
  for (const seg of segments) {
    if (seg.endMs <= dayStartMs || seg.startMs >= nowMs) continue;
    if (seg.status !== "driving") {
      if (runStart === null) runStart = Math.max(seg.startMs, dayStartMs);
    } else {
      if (runStart !== null) {
        const dur = Math.min(seg.startMs, nowMs) - runStart;
        if (dur >= BREAK_LENGTH_MIN * MINUTE_MS) {
          breakCount += 1;
          breakTotalMs += dur;
        }
        runStart = null;
      }
    }
  }
  if (runStart !== null) {
    const dur = nowMs - runStart;
    if (dur >= BREAK_LENGTH_MIN * MINUTE_MS) {
      breakCount += 1;
      breakTotalMs += dur;
    }
  }
  return { drivenMs, onDutyMs, breakCount, breakTotalMs };
}

export function summarizeHos(
  logs: DutySegmentInput[],
  now: Date = new Date(),
  opts: { resetDayStartMs?: number | null } = {},
): HosSummary {
  const nowMs = now.getTime();
  const segments = buildSegments(logs, nowMs);
  const anchor = findShortClockAnchor(segments, { dayStartMs: opts.resetDayStartMs ?? null });
  const windowStartMs = anchor?.startMs ?? null;

  if (windowStartMs === null) {
    return {
      windowStart: null,
      drivingMinutesInWindow: 0,
      windowElapsedMinutes: 0,
      drivingMinutesSinceBreak: 0,
      warnings: [],
    };
  }

  const drivingInWindow = sumMinutes(segments, windowStartMs, nowMs, ["driving"]);
  const windowElapsed = Math.max(0, Math.round((nowMs - windowStartMs - (anchor?.excludedMs ?? 0)) / MINUTE_MS));
  const sinceBreak = drivingSinceBreakMinutes(segments, windowStartMs, nowMs);

  const warnings: string[] = [];
  if (drivingInWindow >= DRIVING_LIMIT_MIN) {
    warnings.push(
      `Driving limit reached in this window (${formatHours(drivingInWindow)} of 11h). Paper-log helper only - the ELD/official log is the legal record.`,
    );
  }
  if (windowElapsed >= WINDOW_LIMIT_MIN && drivingInWindow > 0) {
    warnings.push(
      `14-hour window is used up (${formatHours(windowElapsed)} elapsed). Driving past this point would violate HOS - check the ELD/official log.`,
    );
  }
  if (sinceBreak >= BREAK_REQUIRED_AFTER_MIN) {
    warnings.push(
      `${formatHours(sinceBreak)} of driving since your last 30-minute break - a break is due before driving more.`,
    );
  }

  return {
    windowStart: new Date(windowStartMs).toISOString(),
    drivingMinutesInWindow: drivingInWindow,
    windowElapsedMinutes: windowElapsed,
    drivingMinutesSinceBreak: sinceBreak,
    warnings,
  };
}
