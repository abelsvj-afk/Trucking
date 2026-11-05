// Proactive logging reminders (docs/design/logging-reminders.md; owner-approved
// 2026-11-05, D-4). Pure: given his logged duty rows and "now", which reminders
// are due? PAPER-LOG HELPER, NOT AN ELD - every message says it is based on his
// own logged hours and is planning-grade. A reminder only INFORMS or ASKS; it
// never changes a status or books anything.
//
// Two kinds:
//  - hos: a clock (drive / 14-hour window / break) is about to run out - at
//    30 min, 10 min and 0 left. SAFETY-CRITICAL: delivered immediately, quiet
//    hours do not hold it.
//  - stale_status: the latest status has stood longer than a legal window can
//    (> 14 h of "driving"/"on duty") - the log is probably out of date. Routine:
//    waits for quiet hours to end.

import { buildSegments, findWindowStartMs } from "@/lib/hos";
import { computeHudClocks, type ClockKey } from "@/lib/hud-clocks";
import type { DutyStatus } from "@/types/entities";

export const LOGGING_REMINDERS_CAPABILITY = "logging_reminders";
export const HOS_THRESHOLDS_MIN = [30, 10, 0] as const;
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

const CLOCK_WORDS: Record<Exclude<ClockKey, "cycle">, { label: string; unit: string }> = {
  drive: { label: "driving time", unit: "the 11-hour driving limit" },
  window: { label: "14-hour window", unit: "your 14-hour on-duty window" },
  break: { label: "time before a 30-minute break is due", unit: "the 30-minute break rule (8 hours of driving)" },
};

function easternTime(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function evaluateReminders(rows: ReminderRow[], nowMs: number): Reminder[] {
  const clocks = computeHudClocks(rows, null, nowMs);
  if (clocks.state !== "ready") return [];
  const out: Reminder[] = [];
  const segments = buildSegments(rows, nowMs);
  const windowStartMs = findWindowStartMs(segments) ?? clocks.statusSinceMs;
  const working = clocks.status === "driving" || clocks.status === "on_duty";

  if (working && !clocks.rested) {
    for (const clock of clocks.clocks) {
      if (clock.key === "cycle") continue;
      // The break clock only runs while driving.
      if (clock.key === "break" && clocks.status !== "driving") continue;
      const minutesLeft = Math.ceil(clock.remainingMs / 60_000);
      const threshold = [...HOS_THRESHOLDS_MIN].reverse().find((t) => minutesLeft <= t);
      if (threshold === undefined) continue;
      const words = CLOCK_WORDS[clock.key];
      const text =
        threshold === 0
          ? `Your logged hours say you've used up ${words.unit}. ${DISCLAIMER}`
          : `About ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"} of ${words.label} left (${words.unit}). ${DISCLAIMER}`;
      out.push({
        kind: "hos",
        key: `hos:${clock.key}:${threshold}:${new Date(windowStartMs).toISOString()}`,
        critical: true,
        text,
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
