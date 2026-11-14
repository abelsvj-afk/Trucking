// Server-side rules for POST /api/v1/duty-logs/auto-motion (Block A). Pure so the
// race and history-protection rules are tested without a database.
//
// The app may only ever ADD a Driving row from the detection time forward:
//  - empty log          -> refuse (an unknown status is not assumed);
//  - already Driving    -> nothing to do;
//  - the newest row started at/after the START of the motion run (detection time minus
//    the sustain window) -> a manual change won the race (or the driver deliberately chose
//    a non-driving status while moving); the automatic one stands down;
//  - detected_at in the future, or older than MAX_AGE_MS (a stale retry) -> refuse.
// It never edits or deletes an existing row, so earlier segments cannot be rewritten.

import type { DutyStatus } from "@/types/entities";
import { SUSTAIN_MS } from "./sustained-motion";
import { STOP_PROPOSAL_EXPIRY_MS, STOP_SILENCE_MS } from "./stopped-vehicle";

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
  if (Date.parse(latest.started_at) >= detected - SUSTAIN_MS) return { ok: false, reason: "manual_change_won" };
  return { ok: true };
}

// ---- the stop side (ELD stopped vehicle, App. A §4.4.1.2) --------------------
//
// The mirror of judgeAutoMotion, for the switch OUT of Driving: prompt at
// 5 minutes stopped, auto-switch to On Duty Not Driving at minute 6 on
// silence. It only ever ADDS an On Duty row backdated to the stop start
// (the last movement time), never edits or deletes anything, never
// auto-switches to Off Duty or Sleeper (§4.4.1.3 forbids it), and never
// touches in-motion driving time: the backdate covers only time after
// the last detected movement.

export type AutoStopVerdict =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "no_status"
        | "not_driving"
        | "manual_change_won"
        | "stop_in_future"
        | "stop_too_old"
        | "never_prompted"
        | "silence_not_elapsed"
        | "bad_time";
    };

export function judgeAutoStop(
  latest: { duty_status: DutyStatus; started_at: string } | null,
  stopStartIso: string,
  nowMs: number,
  /** When the 5-minute prompt was shown for this episode — null means never prompted: never auto-switch blind. */
  promptedAtMs: number | null,
): AutoStopVerdict {
  const stopStart = Date.parse(stopStartIso);
  if (!Number.isFinite(stopStart)) return { ok: false, reason: "bad_time" };
  if (stopStart > nowMs + MAX_CLOCK_SKEW_MS) return { ok: false, reason: "stop_in_future" };
  // A stop older than the proposal expiry is a long stop: the hourly
  // re-prompt proposal covers it, not a silent switch hours later.
  if (nowMs - stopStart > STOP_PROPOSAL_EXPIRY_MS) return { ok: false, reason: "stop_too_old" };
  if (!latest) return { ok: false, reason: "no_status" };
  if (latest.duty_status !== "driving") return { ok: false, reason: "not_driving" };
  // A row started at/after the stop start means the Driving segment is
  // already capped (a correction applied) or the driver chose a status
  // after the stop — the automatic one stands down.
  if (Date.parse(latest.started_at) >= stopStart) return { ok: false, reason: "manual_change_won" };
  if (promptedAtMs === null) return { ok: false, reason: "never_prompted" };
  if (nowMs - promptedAtMs < STOP_SILENCE_MS) return { ok: false, reason: "silence_not_elapsed" };
  return { ok: true };
}
