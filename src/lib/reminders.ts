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
//    (> 14 h of "driving"/"on duty") - the log is probably out of date. The hours
//    warnings are then HELD (they would be counted from the wrong log) and this
//    question goes out in their place, delivered like them (critical) - owner 2026-11-16.

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
  // Owner 2026-11-16: four full paragraphs per limit read as a flood. The FIRST warning (2 hours) explains;
  // the follow-ups at 1 hour and 30 minutes are one line, since he already has the explanation.
  if (!expired && threshold < 120) {
    const line =
      clock === "drive" ? `of driving left (11-hour limit), ends ${at} — plan where you'll park`
      : clock === "window" ? `left in your 14-hour window, ends ${at} — it keeps running even when you're not driving, be parked before then`
      : clock === "break" ? `of driving left before your 30-minute break (around ${at}) — 30 straight minutes not driving resets it`
      : `left in your ${cycleLabel ?? "cycle"} (ends ${at}) — after that, 34 straight hours off restarts it`;
    return `⏱️ You have ${leftWords(threshold)} ${line}. Planning only, not an ELD.`;
  }
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
  }) + " ET";
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

  // Owner 2026-11-16: with the log stuck on "Driving since Friday", every cycle warning was counted from a
  // wrong log - five alerts, all noise. A status older than any legal window means the log is out of date,
  // so the hours warnings are held and ONLY the stale-log question goes out; they resume once the log is fixed.
  const stale = working && nowMs - clocks.statusSinceMs > STALE_STATUS_AFTER_MS;

  if (!clocks.rested && !stale) {
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

  if (stale) {
    const word = clocks.status === "driving" ? "Driving" : "On duty";
    out.push({
      kind: "stale_status",
      key: `stale:${new Date(clocks.statusSinceMs).toISOString()}`,
      // It stands in for the held hours warnings, so it is delivered like them: quiet hours never hold it.
      critical: true,
      text:
        `Your log still says ${word} since ${easternTime(clocks.statusSinceMs)} — longer than a duty window can run, so it's probably out of date. ` +
        "If so, tell me the right status and when it changed and I'll ask before changing anything. " +
        "I've paused the hours warnings until then, because they'd be counted from the wrong log.",
    });
  }
  return out;
}

/** One message from everything due now (critical lines first). */
export function composeReminderMessage(reminders: Reminder[]): string {
  const ordered = [...reminders].sort((a, b) => Number(b.critical) - Number(a.critical));
  return ordered.map((r) => r.text).join("\n\n");
}
