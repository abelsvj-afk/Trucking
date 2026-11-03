// Carrier-anchored HOS cycle engine (Reliability Unit B - design
// docs/reliability-wave1-design-package.md B.2.5, F-015).
//
// PAPER-LOG HELPER, NOT AN ELD - the same boundary as lib/hos.ts: these
// numbers come from what the driver manually logged here, are never
// certified, and never replace the truck's ELD or official paper logs,
// which remain the legal record. This engine makes the helper's
// WEEKLY arithmetic match the rule it names (FMCSA 60/7 and 70/8 over
// carrier-anchored consecutive 24-hour periods) - nothing more.
//
// Replaces the pre-Unit-B continuous rolling-192h sum, which had no
// carrier anchor and no period boundaries, so hours fell out
// minute-by-minute instead of period-by-period. Here the oldest
// counted period drops out WHOLE when a new period begins: the cycle
// total is the on-duty time in the current period plus the previous
// 6 (60/7) or 7 (70/8) periods, with duty segments split at period
// boundaries by construction (the counted span starts exactly on a
// boundary).
//
// 34-hour restart (B.2.5): a qualifying restart - 34+ consecutive
// hours off duty/sleeper, observed in the log - moves the counted span
// to begin with the period containing the restart's completion; duty
// before it does not count. The ambiguous-data rule is conservative
// by design: a candidate whose interval START is not observed in the
// fetched sequence (the run begins with the sequence's first event,
// so it may have begun before the window) is NOT applied and is
// reported as restartUnverified - the summary then shows MORE hours
// used, never fewer, so an incomplete log can never make the helper
// claim more available time than the record proves.

import {
  buildSegments,
  isRest,
  sumMinutes,
  type DutySegmentInput,
  type Segment,
} from "./hos";
import {
  cycleLimitMinutes,
  cyclePeriodCount,
  hosPeriodStartMs,
  shiftHosPeriodStartMs,
  type HosCarrierConfig,
} from "./hos-periods";

export type { HosCarrierConfig, HosCycle } from "./hos-periods";
export { PROVISIONAL_HOS_CONFIG } from "./hos-periods";

export interface HosCycleSummary {
  cycle: HosCarrierConfig["cycle"];
  /** On-duty limit for the cycle in minutes (4200 for 70/8, 3600 for 60/7). */
  cycleLimitMinutes: number;
  /** The carrier anchor used, "HH:MM" - rendered on the surface (B.3). */
  periodAnchor: string;
  /** The carrier timezone the periods were computed in (B.3). */
  carrierTimeZone: string;
  onDutyMinutesInCycle: number;
  /** ISO start of the counted span (a carrier period boundary). */
  windowStart: string;
  /** ISO end of the counted span (the evaluation instant). */
  windowEnd: string;
  /** ISO start of the current carrier period. */
  currentPeriodStart: string;
  /**
   * Set when a qualifying 34-hour restart was observed and applied:
   * the instant the 34 hours completed. The UI labels it ("Cycle
   * restarted - 34 h off duty ended ..."), never silently (B.2.5).
   */
  restartApplied: { endedAt: string } | null;
  /**
   * True when the latest qualifying-length rest interval could not be
   * verified from the fetched sequence and was therefore NOT applied
   * (conservative direction). The UI labels it; see the header note.
   */
  restartUnverified: boolean;
  warnings: string[];
}

const MINUTE_MS = 60_000;
const RESTART_MIN_MS = 34 * 60 * MINUTE_MS;

interface RestartCandidate {
  /** Instant the 34 hours completed (interval start + 34h). */
  completionMs: number;
  /** Index of the run's first segment in the fetched sequence. */
  startSegmentIndex: number;
}

function findRestartCandidates(segments: Segment[]): RestartCandidate[] {
  const candidates: RestartCandidate[] = [];
  let runStartIndex: number | null = null;

  const closeRun = (endIndexExclusive: number) => {
    if (runStartIndex === null) return;
    const startMs = segments[runStartIndex]!.startMs;
    const endMs = segments[endIndexExclusive - 1]!.endMs;
    if (endMs - startMs >= RESTART_MIN_MS) {
      candidates.push({ completionMs: startMs + RESTART_MIN_MS, startSegmentIndex: runStartIndex });
    }
    runStartIndex = null;
  };

  segments.forEach((seg, i) => {
    if (isRest(seg.status)) {
      if (runStartIndex === null) runStartIndex = i;
    } else {
      closeRun(i);
    }
  });
  closeRun(segments.length);

  return candidates;
}

function formatHours(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function summarizeHosCycle(
  logs: DutySegmentInput[],
  now: Date = new Date(),
  config: HosCarrierConfig,
): HosCycleSummary {
  const nowMs = now.getTime();
  const segments = buildSegments(logs, nowMs);
  const periods = cyclePeriodCount(config.cycle);
  const limit = cycleLimitMinutes(config.cycle);

  const currentPeriodStartMs = hosPeriodStartMs(nowMs, config);
  const normalCountedFromMs = shiftHosPeriodStartMs(currentPeriodStartMs, -(periods - 1), config);

  let countedFromMs = normalCountedFromMs;
  let restartApplied: { endedAt: string } | null = null;
  let restartUnverified = false;

  if (config.restartEnabled && segments.length > 0) {
    const candidates = findRestartCandidates(segments);
    // Only the LATEST candidate can be the operative restart: duty is
    // counted forward from it, so an earlier one is superseded, and a
    // later unverifiable one voids certainty about the cycle start
    // (the conservative reading - never apply the earlier one either).
    const operative = candidates.reduce<RestartCandidate | null>(
      (latest, c) => (latest === null || c.completionMs > latest.completionMs ? c : latest),
      null,
    );

    if (operative) {
      const completionPeriodStartMs = hosPeriodStartMs(operative.completionMs, config);
      // A restart whose period is not newer than the normal counted
      // window has no effect on today's total (it aged out of the
      // cycle) - it is neither applied nor labeled.
      if (completionPeriodStartMs > normalCountedFromMs) {
        if (operative.startSegmentIndex > 0) {
          // The interval's start is an observed transition inside the
          // fetched sequence: the restart is verifiable. Apply it.
          countedFromMs = completionPeriodStartMs;
          restartApplied = { endedAt: new Date(operative.completionMs).toISOString() };
        } else {
          // The run begins with the fetched sequence's first event:
          // its true start may predate the window (B.2.5's ambiguous
          // case). Do NOT apply it; label it unverified and keep the
          // full-window (higher) total.
          restartUnverified = true;
        }
      }
    }
  }

  const onDutyMinutesInCycle = sumMinutes(segments, countedFromMs, nowMs, ["driving", "on_duty"]);

  const warnings: string[] = [];
  if (onDutyMinutesInCycle >= limit) {
    warnings.push(
      `${config.cycle} on-duty limit reached (${formatHours(onDutyMinutesInCycle)} of ${formatHours(limit)}). ` +
        `A 34-hour restart or waiting for periods to roll off is required - check the ELD/official log.`,
    );
  }

  return {
    cycle: config.cycle,
    cycleLimitMinutes: limit,
    periodAnchor: config.periodAnchor,
    carrierTimeZone: config.carrierTimeZone,
    onDutyMinutesInCycle,
    windowStart: new Date(countedFromMs).toISOString(),
    windowEnd: new Date(nowMs).toISOString(),
    currentPeriodStart: new Date(currentPeriodStartMs).toISOString(),
    restartApplied,
    restartUnverified,
    warnings,
  };
}
