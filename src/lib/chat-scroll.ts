// Stick-to-bottom rules for the Assistant tab's conversation window
// (owner 2026-11-07). The window is a fixed box: messages scroll
// inside it, the composer is stationed below it, and the view sticks
// to the newest message - on open, and while he is at the bottom.
// If he has deliberately scrolled up to read history, an incoming
// message must not yank him down; his own sends always land at the
// bottom. These pure helpers hold that arithmetic so it is testable
// without a DOM.

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Within this many px of the end counts as "at the bottom". */
export const STICK_THRESHOLD_PX = 48;

export function isAtBottom(metrics: ScrollMetrics, thresholdPx: number = STICK_THRESHOLD_PX): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= thresholdPx;
}

/** The scrollTop that pins the newest message into view. */
export function bottomScrollTop(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}

/**
 * Decide whether to pin to the bottom after the turn list changes:
 * always when the change includes his own send, otherwise only when
 * he was already sticking (at the bottom) before it arrived.
 */
export function shouldStickAfterTurnsChange(wasSticking: boolean, ownSend: boolean): boolean {
  return ownSend || wasSticking;
}
