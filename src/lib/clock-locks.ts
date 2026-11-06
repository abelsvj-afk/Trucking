// What an EXPIRED clock locks (owner 2026-11-06: "show what's locked when a clock expires"). Pure,
// plain words, one place. This is INFORMATION about what is not legal to do - the app never blocks
// him from logging the truth (a driver who is driving must be able to log Driving), it tells him what
// the expired clock means. Paper-log helper, not an ELD; his carrier's rules and the ELD govern.

import type { ClockKey, HudClock } from "./hud-clocks";

export interface ClockLock {
  key: ClockKey;
  /** Short: what is locked. */
  locked: string;
  /** Why, in a sentence. */
  why: string;
  /** What is still allowed, so "locked" is not read as "everything is off". */
  stillAllowed: string;
}

const LOCKS: Record<ClockKey, Omit<ClockLock, "key">> = {
  drive: {
    locked: "Driving",
    why: "You've used all 11 hours of driving.",
    stillAllowed: "Other work that isn't driving (paperwork, fueling, inspections) is still allowed.",
  },
  window: {
    locked: "Driving",
    why: "Your 14-hour window is over, even if you have driving hours left.",
    stillAllowed: "Other work that isn't driving is still allowed.",
  },
  break: {
    locked: "Driving",
    why: "You've driven 8 hours without a 30-minute break.",
    stillAllowed: "Anything that isn't driving is allowed - and 30 minutes of it is exactly what resets this.",
  },
  cycle: {
    locked: "Driving",
    why: "You've used up your cycle hours (the cap on total on-duty time across the days it covers).",
    stillAllowed: "Rest counts toward getting hours back; other on-duty work still uses up hours you don't have.",
  },
};

/** The locks in force right now: one per expired clock, in the clocks' order. */
export function activeLocks(clocks: HudClock[]): ClockLock[] {
  return clocks.filter((c) => c.tone === "expired").map((c) => ({ key: c.key, ...LOCKS[c.key] }));
}

/** The reset in words for a ring / panel: "Resets in 9:41:07" while resting, "Starts when you stop - needs 10:00:00" while not. */
export function resetLine(clock: HudClock, format: (ms: number) => string): string | null {
  const reset = clock.reset;
  if (!reset) {
    return clock.tone === "expired" && clock.key === "cycle"
      ? "No timed reset: hours come back as your oldest days fall off (check your recap), or a restart if your carrier allows one."
      : null;
  }
  return reset.underway
    ? `Resets in ${format(reset.remainingMs)} (${reset.how}).`
    : `Reset starts when you stop: needs ${format(reset.requiredMs)} - ${reset.how}.`;
}
