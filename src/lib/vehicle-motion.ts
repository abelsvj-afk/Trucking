// The one driving-safety rule (docs/design/driver-hud.md §5; visual/
// product audit 2026-11-04). A screen that needs reading, typing or
// precise taps may only be fully interactive when the phone POSITIVELY
// reports the vehicle stopped. Everything else - moving, no speed
// reading, a speed reading gone stale, no GPS permission - is treated
// as moving. Unknown must never unlock a more interactive screen.

export const MOVING_MPH = 5;
/** A fix older than this says nothing about the vehicle right now. */
export const FIX_STALE_MS = 15_000;

export type MotionState = "moving" | "stopped" | "unknown";

export function classifyMotion(
  speedMph: number | null | undefined,
  fixAgeMs: number | null | undefined,
): MotionState {
  if (speedMph === null || speedMph === undefined || !Number.isFinite(speedMph) || speedMph < 0) return "unknown";
  if (fixAgeMs === null || fixAgeMs === undefined || !Number.isFinite(fixAgeMs) || fixAgeMs > FIX_STALE_MS) {
    return "unknown";
  }
  return speedMph > MOVING_MPH ? "moving" : "stopped";
}

/** Fail closed: only a positive "stopped" unlocks the fuller screen. */
export function isRestricted(state: MotionState): boolean {
  return state !== "stopped";
}
