// The one driving-safety rule (docs/design/driver-hud.md §5; visual/
// product audit 2026-11-04). A screen that needs reading, typing or
// precise taps may only be fully interactive when the phone POSITIVELY
// reports the vehicle stopped. Everything else - moving, no speed
// reading, a speed reading gone stale, no GPS permission - is treated
// as moving. Unknown must never unlock a more interactive screen.

export const FIX_STALE_MS = 15_000;

export type MotionState = "moving" | "stopped" | "unknown";

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
