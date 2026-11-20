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

// ---- the rest side (owner 2026-11-17: "Auto Off Duty after 2h") ---------------
//
// ASK FIRST (audit F-003, owner 2026-11-20 "do the recommendations"): at 2 hours parked the app asks "going off
// duty?"; only if that question goes unanswered for REST_ASK_SILENCE_MS is the rest logged. (Before, nothing was
// ever asked, yet the note said "no answer to 'going off duty?'".)
// The app put him On Duty when the truck stopped (or never got to), he did not answer, and the
// truck has not moved for 2 hours: that is rest, and leaving it On Duty burns his 14 and his 70 all night - the
// cause of a Smart Path "LATE" for a delivery due tomorrow. The rest is logged Off Duty from when he parked.
// Only an AUTOMATIC row is ever followed: an On Duty he chose himself (loading at a dock) stands.

export const AUTO_REST_AFTER_MS = 2 * 60 * 60_000;
/** After asking "going off duty?", wait this long for an answer before logging the rest. */
export const REST_ASK_SILENCE_MS = 15 * 60_000;

/** The ask counts for THIS park only: made at/after the 2-hour mark of this stop. */
export function restAskedAtForPark(stoppedSinceMs: number, askedAtMs: number | null): number | null {
  if (askedAtMs === null || !Number.isFinite(askedAtMs)) return null;
  return askedAtMs >= stoppedSinceMs + AUTO_REST_AFTER_MS - 60_000 ? askedAtMs : null;
}
/** A park older than this is not acted on (a stale episode; the morning log check covers it). */
export const AUTO_REST_MAX_STOP_AGE_MS = 24 * 60 * 60_000;

export type AutoRestVerdict =
  | { ok: true; startedAtMs: number }
  | { ok: false; reason: "no_status" | "already_resting" | "manual_status" | "not_parked_long_enough" | "stop_too_old" | "row_after_stop" | "bad_time" };

export function judgeAutoRest(
  latest: { duty_status: DutyStatus; started_at: string; source?: string | null } | null,
  stoppedSinceIso: string,
  nowMs: number,
): AutoRestVerdict {
  const stopMs = Date.parse(stoppedSinceIso);
  if (!Number.isFinite(stopMs)) return { ok: false, reason: "bad_time" };
  if (!latest) return { ok: false, reason: "no_status" };
  if (latest.duty_status === "off_duty" || latest.duty_status === "sleeper") return { ok: false, reason: "already_resting" };
  if (nowMs - stopMs < AUTO_REST_AFTER_MS) return { ok: false, reason: "not_parked_long_enough" };
  if (nowMs - stopMs > AUTO_REST_MAX_STOP_AGE_MS) return { ok: false, reason: "stop_too_old" };
  const latestMs = Date.parse(latest.started_at);
  if (!Number.isFinite(latestMs)) return { ok: false, reason: "bad_time" };
  if (latest.duty_status === "driving") {
    // Still "Driving" after 2 h parked: the stop side never ran. The row must predate the stop.
    if (latestMs >= stopMs + 60_000) return { ok: false, reason: "row_after_stop" };
    return { ok: true, startedAtMs: stopMs };
  }
  // On Duty: only the automatic stop row for THIS park is followed; anything he set himself stands.
  if (latest.source !== "auto_motion") return { ok: false, reason: "manual_status" };
  if (latestMs < stopMs - 2 * 60_000 || latestMs > stopMs + 10 * 60_000) return { ok: false, reason: "row_after_stop" };
  return { ok: true, startedAtMs: Math.max(stopMs, latestMs + 1_000) };
}
