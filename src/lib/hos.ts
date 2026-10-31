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
  onDutyMinutesLast8Days: number;
  warnings: string[];
}

const MINUTE_MS = 60_000;
const DRIVING_LIMIT_MIN = 11 * 60;
const WINDOW_LIMIT_MIN = 14 * 60;
const BREAK_REQUIRED_AFTER_MIN = 8 * 60;
const BREAK_LENGTH_MIN = 30;
const RESET_REST_MIN = 10 * 60;
const EIGHT_DAY_ON_DUTY_LIMIT_MIN = 70 * 60;
const EIGHT_DAYS_MS = 8 * 24 * 60 * MINUTE_MS;

interface Segment {
  status: DutyStatus;
  startMs: number;
  endMs: number;
}

function buildSegments(logs: DutySegmentInput[], nowMs: number): Segment[] {
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

function isRest(status: DutyStatus): boolean {
  return status === "off_duty" || status === "sleeper";
}

function sumMinutes(
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
    if (end > start) total += (end - start) / MINUTE_MS;
  }
  return Math.round(total);
}

/**
 * The current 14-hour window starts when a continuous >=10-hour
 * off_duty/sleeper rest ends. If no such rest exists in the logs, the
 * window is taken to start at the earliest log - honest, because the
 * helper only knows what was logged in it.
 */
function findWindowStartMs(segments: Segment[]): number | null {
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
function drivingSinceBreakMinutes(segments: Segment[], windowStartMs: number, nowMs: number): number {
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
  return sumMinutes(segments, breakEndMs, nowMs, ["driving"]);
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
      onDutyMinutesLast8Days: 0,
      warnings: [],
    };
  }

  const drivingInWindow = sumMinutes(segments, windowStartMs, nowMs, ["driving"]);
  const windowElapsed = Math.max(0, Math.round((nowMs - windowStartMs) / MINUTE_MS));
  const sinceBreak = drivingSinceBreakMinutes(segments, windowStartMs, nowMs);
  const onDuty8Days = sumMinutes(segments, nowMs - EIGHT_DAYS_MS, nowMs, ["driving", "on_duty"]);

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
  if (onDuty8Days >= EIGHT_DAY_ON_DUTY_LIMIT_MIN) {
    warnings.push(
      `70-hour / 8-day on-duty limit reached (${formatHours(onDuty8Days)}). A 34-hour reset or waiting for hours to roll off is required - check the ELD/official log.`,
    );
  }

  return {
    windowStart: new Date(windowStartMs).toISOString(),
    drivingMinutesInWindow: drivingInWindow,
    windowElapsedMinutes: windowElapsed,
    drivingMinutesSinceBreak: sinceBreak,
    onDutyMinutesLast8Days: onDuty8Days,
    warnings,
  };
}
