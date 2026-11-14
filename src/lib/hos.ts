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

/**
 * The current 14-hour window starts when a continuous >=10-hour
 * off_duty/sleeper rest ends. If no such rest exists in the logs, the
 * window is taken to start at the earliest log - honest, because the
 * helper only knows what was logged in it.
 */
export function findWindowStartMs(segments: Segment[]): number | null {
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

export function summarizeHos(logs: DutySegmentInput[], now: Date = new Date()): HosSummary {
  const nowMs = now.getTime();
  const segments = buildSegments(logs, nowMs);
  const windowStartMs = findWindowStartMs(segments);

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
  const windowElapsed = Math.max(0, Math.round((nowMs - windowStartMs) / MINUTE_MS));
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
