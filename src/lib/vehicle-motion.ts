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

/**
 * A stop must hold this long before anything unlocks: a lull at 3 mph in
 * traffic, or creeping between 4 and 6 mph, must not flip the screen
 * back and forth or hand over the fuller controls.
 */
export const STOP_SETTLE_MS = 10_000;

/** Fail closed: only a positive "stopped" unlocks the fuller screen. */
export function isRestricted(state: MotionState): boolean {
  return state !== "stopped";
}

/** "stopped" counts only once it has held for STOP_SETTLE_MS; before that it is still restricted. */
export function settleMotion(state: MotionState, stoppedForMs: number | null): MotionState {
  if (state !== "stopped") return state;
  return stoppedForMs !== null && stoppedForMs >= STOP_SETTLE_MS ? "stopped" : "moving";
}
