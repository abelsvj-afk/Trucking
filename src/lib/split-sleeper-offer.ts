// Split-sleeper offer projection (owner 2026-11-17): when he is
// getting close to a drive-time limit and a qualifying split pair is
// still completable - including a first period already taken, e.g.
// last night's partial rest - the app tells him on the clocks what
// taking the second period does, in plain words with real numbers.
// A split is a PARTIAL gain, never a fresh 11: only 10 consecutive
// hours off duty fully resets the 11/14 (§ 395.1(g)(1)(ii)-(iii)).
//
// Pure: given the duty segments and now, project taking the missing
// second period starting now, verify (ii)(D) for the projected pair
// on the simulated timeline, and return what the clocks look like
// the moment the second period ends - or null when no qualifying
// offer exists. Planning only; the ELD's own split calculation is
// the legal one.

import {
  findShortClockAnchor,
  sumMs,
  type RestPeriod,
  type Segment,
} from "@/lib/hos";

const HOUR_MS = 3_600_000;
const DRIVE_LIMIT_MS = 11 * HOUR_MS;
const WINDOW_LIMIT_MS = 14 * HOUR_MS;
const RESET_REST_MS = 10 * HOUR_MS;
const SPLIT_LONG_SLEEPER_MS = 7 * HOUR_MS;
const SPLIT_SHORT_REST_MS = 2 * HOUR_MS;

export interface SplitOffer {
  /** The second period he still needs to take, in ms (taken in the sleeper berth, starting now). */
  neededRestMs: number;
  /** The 14-hour window moves here: the end of the FIRST period of the pair. */
  windowMovesToMs: number;
  /** Driving time left the moment the second period ends - kept, NOT a fresh 11. */
  driveLeftAfterMs: number;
  /** Window time left the moment the second period ends. */
  windowLeftAfterMs: number;
}

/**
 * How much rest the pending first period still needs as its partner:
 * a long (7h+ sleeper) period needs a 2h+ partner; a short (2h+)
 * period needs a 7h+ sleeper partner. Either way the pair must total
 * at least 10 hours.
 */
export function neededPartnerRestMs(period: RestPeriod): number {
  const durMs = period.endMs - period.startMs;
  const isLong = period.longestSleeperMs >= SPLIT_LONG_SLEEPER_MS;
  return isLong
    ? Math.max(SPLIT_SHORT_REST_MS, RESET_REST_MS - durMs)
    : Math.max(SPLIT_LONG_SLEEPER_MS, RESET_REST_MS - durMs);
}

export function computeSplitOffer(
  segments: Segment[],
  nowMs: number,
  opts: { dayStartMs?: number | null } = {},
): SplitOffer | null {
  const anchor = findShortClockAnchor(segments, { dayStartMs: opts.dayStartMs ?? null });
  const pending = anchor?.pending;
  if (!pending) return null;
  // He is already resting: the rest he is taking now IS the answer,
  // not a second period to start. No offer while a rest is under way.
  const last = segments[segments.length - 1];
  if (!last || last.status === "off_duty" || last.status === "sleeper") return null;

  const first = pending.period;
  const neededRestMs = neededPartnerRestMs(first);
  const secondEndMs = nowMs + neededRestMs;
  // Simulate taking the second period in the sleeper starting now,
  // then re-run the anchor on the simulated timeline: the pair must
  // form with this first period AND pass (ii)(D) for both periods
  // (findShortClockAnchor enforces both). A projection that fails
  // (D) offers nothing.
  const simulated: Segment[] = [
    ...segments,
    { status: "sleeper", startMs: nowMs, endMs: secondEndMs },
  ];
  const simAnchor = findShortClockAnchor(simulated, { dayStartMs: opts.dayStartMs ?? null });
  // The pair must form with THIS first period (not an earlier one)
  // and end when the projected rest ends. findShortClockAnchor only
  // forms a pair that passes the shape check AND (ii)(D) for both
  // periods, so a projection that fails (D) lands here as no pair.
  if (
    !simAnchor?.split ||
    simAnchor.split.first.startMs !== first.startMs ||
    simAnchor.split.second.endMs !== secondEndMs
  ) {
    return null;
  }

  const windowMovesToMs = simAnchor.startMs;
  const driveLeftAfterMs =
    DRIVE_LIMIT_MS - sumMs(simulated, windowMovesToMs, secondEndMs, ["driving"]);
  const windowLeftAfterMs =
    WINDOW_LIMIT_MS - Math.max(0, secondEndMs - windowMovesToMs - simAnchor.excludedMs);
  // A split that leaves him nothing to drive on is not an offer.
  if (driveLeftAfterMs <= 0 || windowLeftAfterMs <= 0) return null;
  return { neededRestMs, windowMovesToMs, driveLeftAfterMs, windowLeftAfterMs };
}
