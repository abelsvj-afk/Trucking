// Driver HUD clocks (docs/design/driver-hud.md §2). Pure: given the
// duty rows already fetched, the server's settings-anchored cycle
// summary and "now", return what each ring shows. Ticking is the
// caller advancing `now` once a second - no network, no timers here.
//
// PAPER-LOG HELPER, NOT AN ELD. These are the driver's own logged
// hours. Nothing here certifies anything, and a clock that cannot be
// computed is reported as unavailable - never as a fabricated number.

import {
  buildSegments,
  drivingSinceBreakMs,
  findShortClockAnchor,
  findWindowStartMs,
  type ShortClockAnchor,
  isRest,
  sumMs,
} from "@/lib/hos";
import { computeSplitOffer, type SplitOffer } from "@/lib/split-sleeper-offer";
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

/**
 * What it takes for an EXPIRED clock to come back (owner 2026-11-06: "show the reset clock, red, until
 * green again"). Counted from the same duty rows as the clock itself - no second HOS math.
 */
export interface ClockReset {
  /** How much continuous time the reset needs (10 h off, 30 min not driving, 34 h off). */
  requiredMs: number;
  /** How much of it he has done so far (0 while he is still working). */
  progressMs: number;
  remainingMs: number;
  /** True while the qualifying rest is actually under way right now. */
  underway: boolean;
  /** The condition in plain words. */
  how: string;
}

export interface HudClock {
  key: ClockKey;
  label: string;
  /** Time left; never negative. */
  remainingMs: number;
  totalMs: number;
  tone: ClockTone;
  /** Set only while the clock is expired AND has a time-based reset (the cycle without a restart rule has none). */
  reset?: ClockReset | null;
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
      /** Split sleeper in use or half done, in plain words (null when neither). Optional for older callers. */
      split?: string | null;
      /**
       * A split break he can still take, with what it does to the
       * clocks (lib/split-sleeper-offer.ts) - set only when a limit
       * is close (drive or window <= 2 h) AND an offer exists. That
       * is the popup; otherwise the quiet `split` note above stands.
       */
      splitOffer?: SplitOffer | null;
      /**
       * The clocks were reset by hand at this instant (manual reset,
       * never automatic) - the short clocks run from here. Null
       * when no hand reset is on record.
       */
      clockResetAtMs?: number | null;
    };

/** Ring escalation (Block B, owner 2026-11-05): green normally, amber at <= 2 h, red at <= 30 min, expired unmistakable. */
export const WARN_AT_MS = 2 * 60 * MINUTE_MS;
export const CRITICAL_AT_MS = 30 * MINUTE_MS;

export function toneFor(remainingMs: number): ClockTone {
  if (remainingMs <= 0) return "expired";
  if (remainingMs <= CRITICAL_AT_MS) return "critical";
  if (remainingMs <= WARN_AT_MS) return "warn";
  return "ok";
}

/** The tone in words - colour is never the only signal. One source for every surface that shows a clock. */
export const TONE_WORDS: Record<ClockTone, string> = {
  ok: "",
  warn: "Under 2 hours",
  critical: "Under 30 minutes",
  expired: "EXPIRED",
};

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

const RESET_HOW = "10 straight hours off duty or in the sleeper berth - or a split: 7+ straight hours in the sleeper plus 2+ off, 10 total";

const hmWords = (ms: number) => {
  const m = Math.round(ms / MINUTE_MS);
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
};

/** The split-sleeper state in his words - planning only; the ELD's own split calculation is the legal one. */
export function splitNote(anchor: ShortClockAnchor | null): string | null {
  if (!anchor) return null;
  if (anchor.pending) {
    return `Split sleeper: your ${hmWords(anchor.pending.period.endMs - anchor.pending.period.startMs)} rest counts as the first half - take ${anchor.pending.needs}.`;
  }
  if (anchor.split) {
    const a = anchor.split.first.endMs - anchor.split.first.startMs;
    const b = anchor.split.second.endMs - anchor.split.second.startMs;
    return `Split sleeper in use (${hmWords(a)} + ${hmWords(b)}): your clocks run from the end of the first rest, and the second rest doesn't count against your 14.`;
  }
  return null;
}

export function computeHudClocks(
  rows: HudDutyRow[],
  cycle: DutyLogWindowSummary | null,
  nowMs: number,
  opts: { resetDayStartMs?: number | null; clockResetAtMs?: number | null } = {},
): HudClocks {
  const segments = buildSegments(rows, nowMs);
  const last = segments[segments.length - 1];
  if (!last) return { state: "no-logs" };

  // Manual clock reset (owner 2026-11-17): a hand reset re-derives
  // the short clocks from TODAY's log - it never wipes the day.
  // resetDayStartMs is the start of the reset day in his timezone;
  // the anchor is re-derived from that day's segments (driving,
  // on-duty, breaks and any pending split first period all still
  // count). The cycle is untouched: it reads the same rows through
  // the server summary, and no row was changed.
  const resetDayStartMs = opts.resetDayStartMs ?? null;

  // Split sleeper (2026-11-17): the clocks run from the end of the first period of a completed pair, and the
  // paired second period does not count against the 14-hour window.
  const anchor = findShortClockAnchor(segments, { dayStartMs: resetDayStartMs });
  const windowStartMs = anchor?.startMs ?? last.startMs;
  const drivingInWindow = sumMs(segments, windowStartMs, nowMs, ["driving"]);
  const drivingSinceBreak = drivingSinceBreakMs(segments, windowStartMs, nowMs);
  const windowElapsed = Math.max(0, nowMs - windowStartMs - (anchor?.excludedMs ?? 0));

  // How long he has been continuously at rest, if he is.
  let restStartMs: number | null = null;
  if (isRest(last.status)) {
    restStartMs = last.startMs;
    for (let i = segments.length - 2; i >= 0 && isRest(segments[i]!.status); i--) {
      restStartMs = segments[i]!.startMs;
    }
  }
  const rested = restStartMs !== null && nowMs - restStartMs >= RESET_REST_MS;

  // Reset progress, from the same rows: continuous rest (off duty / sleeper) so far, and continuous
  // time not driving so far (for the 30-minute break).
  const restSoFarMs = restStartMs !== null ? Math.max(0, nowMs - restStartMs) : 0;
  let notDrivingSinceMs: number | null = null;
  if (last.status !== "driving") {
    notDrivingSinceMs = last.startMs;
    for (let i = segments.length - 2; i >= 0 && segments[i]!.status !== "driving"; i--) notDrivingSinceMs = segments[i]!.startMs;
  }
  const notDrivingSoFarMs = notDrivingSinceMs !== null ? Math.max(0, nowMs - notDrivingSinceMs) : 0;
  const withReset = (c: HudClock, requiredMs: number | null, progressMs: number, how: string): HudClock => {
    if (c.tone !== "expired" || requiredMs === null) return c;
    const progress = Math.min(requiredMs, progressMs);
    return { ...c, reset: { requiredMs, progressMs: progress, remainingMs: requiredMs - progress, underway: progressMs > 0, how } };
  };

  const clocks: HudClock[] = [
    withReset(clock("drive", "Drive", DRIVE_LIMIT_MS, drivingInWindow), RESET_REST_MS, restSoFarMs, RESET_HOW),
    withReset(clock("window", "14-hour window", WINDOW_LIMIT_MS, windowElapsed), RESET_REST_MS, restSoFarMs, RESET_HOW),
    withReset(clock("break", "Break due in", BREAK_AFTER_DRIVING_MS, drivingSinceBreak), 30 * MINUTE_MS, notDrivingSoFarMs, "30 straight minutes not driving"),
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
      withReset(
        clock("cycle", `${cycle.cycle} cycle`, limitMs, cycle.onDutyMinutesInCycle * MINUTE_MS + sinceFetch),
        // Only when the 34-hour restart is switched on in the driver's hours settings does the cycle have a time-based reset; otherwise hours return as old days fall off.
        cycle.restartEnabled ? 34 * HOUR_MS : null,
        restSoFarMs,
        "34 straight hours off duty (the restart)",
      ),
    );
    cycleUnavailable = false;
  }

  // The split offer is the popup: only when a limit is close (drive
  // or window at 2 h or less) AND a qualifying pair is still
  // completable. Otherwise the quiet split note above stands. The
  // offer is projected on the same (day-aware, when reset) anchor
  // as the clocks, so a pending first period from today survives a
  // reset and can still be offered.
  const driveLeftMs = clocks.find((c) => c.key === "drive")?.remainingMs ?? Number.POSITIVE_INFINITY;
  const windowLeftMs = clocks.find((c) => c.key === "window")?.remainingMs ?? Number.POSITIVE_INFINITY;
  const splitOffer =
    Math.min(driveLeftMs, windowLeftMs) <= WARN_AT_MS
      ? computeSplitOffer(segments, nowMs, { dayStartMs: resetDayStartMs })
      : null;

  return {
    state: "ready",
    status: last.status,
    statusSinceMs: last.startMs,
    rested,
    clocks,
    cycleUnavailable,
    split: splitNote(anchor),
    splitOffer,
    clockResetAtMs: opts.clockResetAtMs ?? null,
  };
}
