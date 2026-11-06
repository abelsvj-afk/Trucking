// Sustained motion / sustained standstill from a stream of GPS fixes (Block A of
// docs/design/driver-hud-round2.md). Pure. Built on top of the bubble estimator's
// per-fix verdict: a fix counts toward "moving" only when BOTH the speed is at or above
// SUSTAIN_MIN_MPH and the estimator says moving, so dock creep (< 5 mph) and GPS jitter
// at a standstill never accumulate. No evidence is not motion: a gap between fixes longer
// than FIX_GAP_RESET_MS (tunnel, lost GPS) resets everything.

export const SUSTAIN_MIN_MPH = 5;
/** Motion must hold this long before it is "sustained". */
export const SUSTAIN_MS = 60_000;
/** A slow patch shorter than this does not break sustained motion (stop-and-go traffic). */
export const DIP_TOLERANCE_MS = 15_000;
/** No fix for longer than this: nothing is known, so nothing carries over. */
export const FIX_GAP_RESET_MS = 20_000;
/** Driving but stationary this long -> offer to switch out of Driving (prompt only). */
export const STATIONARY_PROMPT_MS = 5 * 60_000;

export interface SustainedState {
  /** When the current unbroken run of moving fixes began, or null. */
  movingSinceMs: number | null;
  /** The last fix that counted as moving (for dip tolerance). */
  lastMovingFixAtMs: number | null;
  /** When the current unbroken run of positively-stopped fixes began, or null. */
  stoppedSinceMs: number | null;
  lastFixAtMs: number | null;
}

export const NO_SUSTAINED: SustainedState = {
  movingSinceMs: null,
  lastMovingFixAtMs: null,
  stoppedSinceMs: null,
  lastFixAtMs: null,
};

export interface SustainedFix {
  atMs: number;
  speedMph: number | null;
  /** The bubble estimator's verdict after this fix. */
  estimator: "moving" | "stopped" | "unknown";
}

export function stepSustained(prev: SustainedState, fix: SustainedFix): SustainedState {
  let s = prev;
  if (s.lastFixAtMs !== null && fix.atMs - s.lastFixAtMs > FIX_GAP_RESET_MS) s = NO_SUSTAINED;

  const movingFix = fix.estimator === "moving" && fix.speedMph !== null && fix.speedMph >= SUSTAIN_MIN_MPH;
  const stoppedFix = fix.estimator === "stopped" && (fix.speedMph === null || fix.speedMph < SUSTAIN_MIN_MPH);

  if (movingFix) {
    return {
      movingSinceMs: s.movingSinceMs ?? fix.atMs,
      lastMovingFixAtMs: fix.atMs,
      stoppedSinceMs: null,
      lastFixAtMs: fix.atMs,
    };
  }
  if (stoppedFix) {
    return { movingSinceMs: null, lastMovingFixAtMs: null, stoppedSinceMs: s.stoppedSinceMs ?? fix.atMs, lastFixAtMs: fix.atMs };
  }
  // Ambiguous or slow fix: a short dip keeps an established run of motion; anything else clears it.
  const withinDip = s.lastMovingFixAtMs !== null && fix.atMs - s.lastMovingFixAtMs <= DIP_TOLERANCE_MS;
  return {
    movingSinceMs: withinDip ? s.movingSinceMs : null,
    lastMovingFixAtMs: withinDip ? s.lastMovingFixAtMs : null,
    stoppedSinceMs: null,
    lastFixAtMs: fix.atMs,
  };
}

/** How long motion has been sustained as of `nowMs` (0 when it is not, or the signal is gone). */
export function movingForMs(s: SustainedState, nowMs: number): number {
  if (s.movingSinceMs === null || s.lastFixAtMs === null) return 0;
  if (nowMs - s.lastFixAtMs > FIX_GAP_RESET_MS) return 0;
  // A run that has gone slow beyond the dip tolerance is over even before the next fix says so.
  if (s.lastMovingFixAtMs !== null && nowMs - s.lastMovingFixAtMs > DIP_TOLERANCE_MS) return 0;
  return Math.max(0, nowMs - s.movingSinceMs);
}

/** How long the truck has been positively stopped as of `nowMs` (0 when unknown or the signal is gone). */
export function stoppedForMs(s: SustainedState, nowMs: number): number {
  if (s.stoppedSinceMs === null || s.lastFixAtMs === null) return 0;
  if (nowMs - s.lastFixAtMs > FIX_GAP_RESET_MS) return 0;
  return Math.max(0, nowMs - s.stoppedSinceMs);
}
