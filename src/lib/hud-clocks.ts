// Driver HUD clocks (docs/design/driver-hud.md §2). Pure: given the
// duty rows already fetched, the server's carrier-anchored cycle
// summary and "now", return what each ring shows. Ticking is the
// caller advancing `now` once a second - no network, no timers here.
//
// PAPER-LOG HELPER, NOT AN ELD. These are the driver's own logged
// hours. Nothing here certifies anything, and a clock that cannot be
// computed is reported as unavailable - never as a fabricated number.

import {
  buildSegments,
  drivingSinceBreakMs,
  findWindowStartMs,
  isRest,
  sumMs,
} from "@/lib/hos";
import type { DutyStatus } from "@/types/entities";
import type { DutyLogWindowSummary } from "@/types/hos-settings";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
export const DRIVE_LIMIT_MS = 11 * HOUR_MS;
export const WINDOW_LIMIT_MS = 14 * HOUR_MS;
export const BREAK_AFTER_DRIVING_MS = 8 * HOUR_MS;
const RESET_REST_MS = 10 * HOUR_MS;

export type ClockTone = "ok" | "warn" | "critical" | "expired";
export type ClockKey = "drive" | "window" | "break" | "cycle";

export interface HudClock {
  key: ClockKey;
  label: string;
  /** Time left; never negative. */
  remainingMs: number;
  totalMs: number;
  tone: ClockTone;
}

export interface HudDutyRow {
  duty_status: DutyStatus;
  started_at: string;
}

export type HudClocks =
  | { state: "no-logs" }
  | {
      state: "ready";
      status: DutyStatus;
      statusSinceMs: number;
      /** Rested >=10h: drive/window are full and start when he goes on duty. */
      rested: boolean;
      /** drive, window, break always; cycle only when the server summary is usable. */
      clocks: HudClock[];
      /** The cycle clock could not be computed (no server summary) - say so. */
      cycleUnavailable: boolean;
    };

export function toneFor(remainingMs: number): ClockTone {
  if (remainingMs <= 0) return "expired";
  if (remainingMs <= 15 * MINUTE_MS) return "critical";
  if (remainingMs <= 60 * MINUTE_MS) return "warn";
  return "ok";
}

function clock(key: ClockKey, label: string, totalMs: number, usedMs: number): HudClock {
  const remainingMs = Math.max(0, totalMs - usedMs);
  return { key, label, remainingMs, totalMs, tone: toneFor(remainingMs) };
}

/** H:MM:SS for a ring's centre. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function computeHudClocks(
  rows: HudDutyRow[],
  cycle: DutyLogWindowSummary | null,
  nowMs: number,
): HudClocks {
  const segments = buildSegments(rows, nowMs);
  const last = segments[segments.length - 1];
  if (!last) return { state: "no-logs" };

  const windowStartMs = findWindowStartMs(segments) ?? last.startMs;
  const drivingInWindow = sumMs(segments, windowStartMs, nowMs, ["driving"]);
  const drivingSinceBreak = drivingSinceBreakMs(segments, windowStartMs, nowMs);
  const windowElapsed = Math.max(0, nowMs - windowStartMs);

  // How long he has been continuously at rest, if he is.
  let restStartMs: number | null = null;
  if (isRest(last.status)) {
    restStartMs = last.startMs;
    for (let i = segments.length - 2; i >= 0 && isRest(segments[i]!.status); i--) {
      restStartMs = segments[i]!.startMs;
    }
  }
  const rested = restStartMs !== null && nowMs - restStartMs >= RESET_REST_MS;

  const clocks: HudClock[] = [
    clock("drive", "Drive", DRIVE_LIMIT_MS, drivingInWindow),
    clock("window", "14-hour window", WINDOW_LIMIT_MS, windowElapsed),
    clock("break", "Break due in", BREAK_AFTER_DRIVING_MS, drivingSinceBreak),
  ];

  let cycleUnavailable = true;
  if (cycle) {
    const windowEndMs = new Date(cycle.windowEnd).getTime();
    const onDuty = last.status === "driving" || last.status === "on_duty";
    // The server total is as of windowEnd; while on duty, time since
    // then is also on-duty time. Never negative if clocks disagree.
    const sinceFetch = onDuty && Number.isFinite(windowEndMs) ? Math.max(0, nowMs - windowEndMs) : 0;
    const limitMs = cycle.cycleLimitMinutes * MINUTE_MS;
    clocks.push(
      clock("cycle", `${cycle.cycle} cycle`, limitMs, cycle.onDutyMinutesInCycle * MINUTE_MS + sinceFetch),
    );
    cycleUnavailable = false;
  }

  return {
    state: "ready",
    status: last.status,
    statusSinceMs: last.startMs,
    rested,
    clocks,
    cycleUnavailable,
  };
}
