// Server-side rules for POST /api/v1/duty-logs/auto-motion (Block A). Pure so the
// race and history-protection rules are tested without a database.
//
// The app may only ever ADD a Driving row from the detection time forward:
//  - empty log          -> refuse (an unknown status is not assumed);
//  - already Driving    -> nothing to do;
//  - the newest row started at/after the detection time -> a manual change won the
//    race (or already covers it); the automatic one stands down;
//  - detected_at in the future, or older than MAX_AGE_MS (a stale retry) -> refuse.
// It never edits or deletes an existing row, so earlier segments cannot be rewritten.

import type { DutyStatus } from "@/types/entities";

export const MAX_DETECTION_AGE_MS = 10 * 60_000;
export const MAX_CLOCK_SKEW_MS = 60_000;

export type AutoMotionVerdict =
  | { ok: true }
  | { ok: false; reason: "no_status" | "already_driving" | "manual_change_won" | "detection_in_future" | "detection_too_old" | "bad_time" };

export function judgeAutoMotion(
  latest: { duty_status: DutyStatus; started_at: string } | null,
  detectedAtIso: string,
  nowMs: number,
): AutoMotionVerdict {
  const detected = Date.parse(detectedAtIso);
  if (!Number.isFinite(detected)) return { ok: false, reason: "bad_time" };
  if (detected > nowMs + MAX_CLOCK_SKEW_MS) return { ok: false, reason: "detection_in_future" };
  if (nowMs - detected > MAX_DETECTION_AGE_MS) return { ok: false, reason: "detection_too_old" };
  if (!latest) return { ok: false, reason: "no_status" };
  if (latest.duty_status === "driving") return { ok: false, reason: "already_driving" };
  if (Date.parse(latest.started_at) >= detected) return { ok: false, reason: "manual_change_won" };
  return { ok: true };
}

/** "3:42 PM ET" - Eastern, never UTC. */
export function easternClock(iso: string): string {
  return (
    new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) + " ET"
  );
}
