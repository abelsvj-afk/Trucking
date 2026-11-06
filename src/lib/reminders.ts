// Proactive logging reminders (docs/design/logging-reminders.md; owner-approved
// 2026-11-05, D-4). Pure: given his logged duty rows and "now", which reminders
// are due? PAPER-LOG HELPER, NOT AN ELD - every message says it is based on his
// own logged hours and is planning-grade. A reminder only INFORMS or ASKS; it
// never changes a status or books anything.
//
// Two kinds:
//  - hos: a clock (drive / 14-hour window / break / cycle) is about to run out - at
//    2 h, 1 h, 30 min and expiry. Each message says the CONSEQUENCE and the ACTION in
//    plain words. SAFETY-CRITICAL: delivered immediately, quiet hours do not hold it,
//    and only at those thresholds. Once per threshold per clock per shift (dedupe key).
//  - stale_status: the latest status has stood longer than a legal window can
//    (> 14 h of "driving"/"on duty") - the log is probably out of date. Routine:
//    waits for quiet hours to end.

import { buildSegments, findWindowStartMs } from "@/lib/hos";
import { computeHudClocks, type ClockKey } from "@/lib/hud-clocks";
import type { DutyStatus } from "@/types/entities";
import type { DutyLogWindowSummary } from "@/types/hos-settings";

export const LOGGING_REMINDERS_CAPABILITY = "logging_reminders";
/** Minutes remaining at which a clock is announced (0 = expired). Block B: 2 h, 1 h, 30 min, expiry. */
export const HOS_THRESHOLDS_MIN = [120, 60, 30, 0] as const;
export const STALE_STATUS_AFTER_MS = 14 * 3_600_000;

export interface ReminderRow {
  duty_status: DutyStatus;
  started_at: string;
}

export interface Reminder {
  kind: "hos" | "stale_status";
  /** Persisted dedupe key: the same key is never sent twice. */
  key: string;
  /** True = bypasses quiet hours and the driving hold. */
  critical: boolean;
  text: string;
}

const DISCLAIMER = "Based on your logged hours — planning only, not an ELD.";

/** "2 hours", "1 hour", "30 minutes" - the threshold in words. */
function leftWords(threshold: number): string {
  if (threshold >= 120) return "about 2 hours";
  if (threshold >= 60) return "about 1 hour";
  return "about 30 minutes";
}

/**
 * The plain-words text for one clock at one threshold: what is happening, what it means, what to do.
 * `endsAtMs` is when the clock reaches zero if it keeps running as it is.
 */
export function hosReminderText(
  clock: ClockKey,
  threshold: number,
  endsAtMs: number,
  cycleLabel: string | null,
): string {
  const at = easternTime(endsAtMs);
  const expired = threshold === 0;
  switch (clock) {
    case "drive":
      return expired
        ? `You've used all 11 hours of driving. You can't drive again until you've had 10 straight hours off. Park safely now and start your 10 hours off. ${DISCLAIMER}`
        : `You have ${leftWords(threshold)} of driving left (the 11-hour driving limit). It runs out around ${at}. After that you can't drive until you've had 10 straight hours off — plan where you'll park. ${DISCLAIMER}`;
    case "window":
      return expired
        ? `Your 14-hour window has ended. You can't drive until you've had 10 straight hours off. Get parked safely and start your 10 hours off. ${DISCLAIMER}`
        : `Your 14-hour window ends at ${at} — ${leftWords(threshold)} from now. The window keeps running even when you're not driving. After it ends you can't drive until you've had 10 straight hours off, so be parked before then. ${DISCLAIMER}`;
    case "break":
      return expired
        ? `You've driven 8 hours without a 30-minute break. Stop and take 30 straight minutes not driving (off duty, sleeper, or on duty not driving) before you drive any more. ${DISCLAIMER}`
        : `You'll need a 30-minute break in ${leftWords(threshold)} of driving, around ${at}. After 8 hours of driving without one you can't keep driving. Any 30 straight minutes not driving resets it — plan a stop. ${DISCLAIMER}`;
    case "cycle": {
      const name = cycleLabel ?? "cycle";
      return expired
        ? `Your ${name} is used up: you've hit the limit on total on-duty hours. You can't drive until hours come back as old days fall off, or you take 34 straight hours off to restart it. Check your recap and plan a restart. ${DISCLAIMER}`
        : `You have ${leftWords(threshold)} left in your ${name} (the cap on total on-duty hours across the days it covers). When it's gone you can't drive until hours come back as old days fall off, or you take 34 straight hours off to restart it. Check your recap now. ${DISCLAIMER}`;
    }
  }
}

function easternTime(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function evaluateReminders(
  rows: ReminderRow[],
  nowMs: number,
  /** The server's cycle summary (from the one HOS read); without it the cycle clock is simply not announced. */
  cycle: DutyLogWindowSummary | null = null,
): Reminder[] {
  const clocks = computeHudClocks(rows, cycle, nowMs);
  if (clocks.state !== "ready") return [];
  const out: Reminder[] = [];
  const segments = buildSegments(rows, nowMs);
  const windowStartMs = findWindowStartMs(segments) ?? clocks.statusSinceMs;
  const working = clocks.status === "driving" || clocks.status === "on_duty";

  if (!clocks.rested) {
    for (const clock of clocks.clocks) {
      // The 14-hour window runs on ANY time, working or not; the others only matter while he is working.
      if (clock.key !== "window" && !working) continue;
      // The break clock only runs while driving.
      if (clock.key === "break" && clocks.status !== "driving") continue;
      const minutesLeft = Math.ceil(clock.remainingMs / 60_000);
      const threshold = [...HOS_THRESHOLDS_MIN].reverse().find((t) => minutesLeft <= t);
      if (threshold === undefined) continue;
      // Not working (parked, off duty) and the window has already ended: nothing to warn about.
      if (clock.key === "window" && !working && threshold === 0) continue;
      // "Per shift": the drive/window/break clocks reset with his rest, so they are keyed by the window start;
      // the cycle is keyed by the carrier period it is read in.
      const shiftKey = clock.key === "cycle" ? (cycle?.currentPeriodStart ?? "cycle") : new Date(windowStartMs).toISOString();
      out.push({
        kind: "hos",
        key: `hos:${clock.key}:${threshold}:${shiftKey}`,
        critical: true,
        text: hosReminderText(clock.key, threshold, nowMs + clock.remainingMs, cycle ? cycle.cycle : null),
      });
    }
  }

  if (working && nowMs - clocks.statusSinceMs > STALE_STATUS_AFTER_MS) {
    const word = clocks.status === "driving" ? "Driving" : "On duty";
    out.push({
      kind: "stale_status",
      key: `stale:${new Date(clocks.statusSinceMs).toISOString()}`,
      critical: false,
      text:
        `Your log still says ${word} since ${easternTime(clocks.statusSinceMs)} — longer than a duty window can run, so it's probably out of date. ` +
        "If so, tell me the right status and when it changed and I'll ask before changing anything.",
    });
  }
  return out;
}

/** One message from everything due now (critical lines first). */
export function composeReminderMessage(reminders: Reminder[]): string {
  const ordered = [...reminders].sort((a, b) => Number(b.critical) - Number(a.critical));
  return ordered.map((r) => r.text).join("\n\n");
}
