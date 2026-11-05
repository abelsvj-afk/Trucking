// What the app-wide driving lock does for a given motion + duty status
// (owner request 2026-11-05: "if I'm On Duty Not Driving at a dock and the
// truck creeps, don't lock me out of my own logs"). Pure.
//
//  - Not moving                      -> nothing.
//  - Status Driving                  -> LOCK (unchanged).
//  - No status / unknown / loading   -> LOCK (unchanged: nothing is assumed).
//  - Status On duty / Off duty /
//    Sleeper, moving SLOWLY          -> MISMATCH: forms stay open, the app asks
//                                       whether to switch to Driving.
//  - Same non-driving status but the speed is at/above MISMATCH_MAX_MPH, or the
//    speed is unknown                -> LOCK. A truck doing 30 mph is driving
//    whatever the log says (and an unverifiable "slow" is not slow). This is the
//    one deliberate narrowing of the request, so a mislogged status can never
//    unlock a truck at road speed; the owner may change the threshold.
//
// The HUD and Drive surfaces do NOT use this: they stay strictly fail-closed.

import type { DutyStatus } from "@/types/entities";
import type { MotionState } from "./vehicle-motion";

/** A yard move / dock creep is slower than this; at or above it the lock stays. */
export const MISMATCH_MAX_MPH = 15;

export type DutyKnowledge = DutyStatus | "unknown";

export type LockDecision =
  | { kind: "none" }
  | { kind: "lock" }
  | { kind: "mismatch"; status: Exclude<DutyStatus, "driving"> };

export function decideLock(motion: MotionState, duty: DutyKnowledge, speedMph: number | null): LockDecision {
  if (motion !== "moving") return { kind: "none" };
  if (duty === "driving" || duty === "unknown") return { kind: "lock" };
  if (speedMph === null || !Number.isFinite(speedMph) || speedMph >= MISMATCH_MAX_MPH) return { kind: "lock" };
  return { kind: "mismatch", status: duty };
}
