// What the app does about a duty status that disagrees with how the truck is behaving
// (Block A, docs/design/driver-hud-round2.md). Pure.
//
//   status not Driving + motion sustained 60 s  -> DETECTED: show the prompt now,
//        and AUTO-SWITCH to Driving once AUTO_SWITCH_GRACE_MS more has passed with
//        motion still sustained. The switch is stamped at the DETECTION time
//        (movingSince + SUSTAIN_MS): from that moment forward, never earlier.
//   status Driving + stationary >= 5 min        -> PROMPT only (On duty / Off duty).
//        It never auto-switches out of Driving.
//   status unknown (no log, loading, error)    -> nothing: an unknown status is not assumed.

import type { DutyStatus } from "@/types/entities";
import {
  SUSTAIN_MS,
  STATIONARY_PROMPT_MS,
  movingForMs,
  stoppedForMs,
  type SustainedState,
} from "./sustained-motion";

export const AUTO_SWITCH_GRACE_MS = 30_000;

export type AutoDecision =
  | { kind: "none" }
  /** Motion is sustained and the status is not Driving: prompt now; auto-switch at autoSwitchAtMs if it continues. */
  | { kind: "detected"; detectedAtMs: number; autoSwitchAtMs: number }
  /** The grace has passed with motion still sustained: switch now, stamped at detectedAtMs. */
  | { kind: "auto_switch"; detectedAtMs: number }
  /** Driving but stationary long enough to ask. Prompt only. */
  | { kind: "still_driving_prompt"; stoppedForMs: number };

export function decideAuto(
  duty: DutyStatus | "unknown",
  s: SustainedState,
  nowMs: number,
  /** When the newest log row started. A row logged AFTER the motion began is the driver's own deliberate choice - the app does not overrule it. */
  latestRowStartedMs: number | null = null,
): AutoDecision {
  if (duty === "unknown") return { kind: "none" };
  if (duty === "driving") {
    const stopped = stoppedForMs(s, nowMs);
    return stopped >= STATIONARY_PROMPT_MS ? { kind: "still_driving_prompt", stoppedForMs: stopped } : { kind: "none" };
  }
  const moving = movingForMs(s, nowMs);
  if (moving < SUSTAIN_MS || s.movingSinceMs === null) return { kind: "none" };
  if (latestRowStartedMs !== null && latestRowStartedMs >= s.movingSinceMs) return { kind: "none" };
  const detectedAtMs = s.movingSinceMs + SUSTAIN_MS;
  const autoSwitchAtMs = detectedAtMs + AUTO_SWITCH_GRACE_MS;
  return nowMs >= autoSwitchAtMs ? { kind: "auto_switch", detectedAtMs } : { kind: "detected", detectedAtMs, autoSwitchAtMs };
}
