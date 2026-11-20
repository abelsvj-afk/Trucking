// Background movement from Telegram Live Location (owner request
// 2026-11-05: tracking that works with the screen off). Pure.
// Telegram's own app streams the phone's position to the bot even when
// ours is closed. From those positions this derives speed, tracks movement
// and stop "episodes", and decides when Abel should PROPOSE a duty-status
// change - like an ELD's drive detection, but never booking anything: a
// proposal waits for his yes, and the time it carries is when the
// movement actually began.

import { DIP_TOLERANCE_MS } from "./sustained-motion";
import type { DutyStatus } from "@/types/entities";
import { episodeKey } from "./stopped-vehicle";

type LatLng = { lat: number; lng: number };

const EARTH_RADIUS_MILES = 3958.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function haversineMiles(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Position fixes closer in time than this give a noisy speed; farther than the max can't be trusted as continuous. */
export const MIN_SPEED_INTERVAL_MS = 3_000;
export const MAX_SPEED_INTERVAL_MS = 5 * 60_000;
/** A fix this inaccurate can't support a speed. */
export const MAX_ACCURACY_M = 100;
/** Distance a stationary phone appears to wander is not movement: below this it is zero. */
export const JITTER_FLOOR_MILES = 0.01;
/**
 * The jitter floor for two GOOD fixes (both accuracies known and within
 * GOOD_ACCURACY_M). 2026-11-19: the Tracker now sends a fix every 5 s,
 * and 0.01 mi in 5 s is 7.2 mph — every slower pair (pulling out of a
 * lot, creeping through town) read as 0 mph, reset the motion run, and
 * the switch back to Driving never fired. A good fix wanders far less
 * than 16 m, so it gets a floor under the 5 mph moving line.
 */
export const GOOD_FIX_JITTER_FLOOR_MILES = 0.004;
export const GOOD_ACCURACY_M = 20;
/** A pair with an unknown accuracy must move farther than two worst-case errors (2 × MAX_ACCURACY_M) to count. */
export const UNKNOWN_ACCURACY_MOVE_MILES = (2 * MAX_ACCURACY_M) / 1609.344;

export interface PositionFix extends LatLng {
  atMs: number;
  accuracyM: number | null;
}

/** mph between two consecutive fixes, or null when it can't be judged honestly. */
export function deriveSpeedMph(prev: PositionFix | null, cur: PositionFix): number | null {
  if (!prev) return null;
  const dt = cur.atMs - prev.atMs;
  if (dt < MIN_SPEED_INTERVAL_MS || dt > MAX_SPEED_INTERVAL_MS) return null;
  if ((cur.accuracyM ?? 0) > MAX_ACCURACY_M || (prev.accuracyM ?? 0) > MAX_ACCURACY_M) return null;
  const miles = haversineMiles(prev, cur);
  if (cur.accuracyM === null || prev.accuracyM === null) {
    // Unknown accuracy is UNKNOWN, not perfect (audit F-012/F-021). Telegram omits it on
    // some updates, so such a pair is judged at the WORST accuracy we accept: it can never
    // prove a stop, and it counts as movement only past what two 100 m errors could fake.
    return miles > UNKNOWN_ACCURACY_MOVE_MILES ? miles / (dt / 3_600_000) : null;
  }
  const good = cur.accuracyM <= GOOD_ACCURACY_M && prev.accuracyM <= GOOD_ACCURACY_M;
  if (miles < (good ? GOOD_FIX_JITTER_FLOOR_MILES : JITTER_FLOOR_MILES)) return 0;
  return miles / (dt / 3_600_000);
}

// ---- movement episodes -------------------------------------------------------

/** Same speed as the open-app detector (lib/sustained-motion.ts SUSTAIN_MIN_MPH): the owner's ~5 mph. Derived speed ignores jitter below JITTER_FLOOR_MILES. */
export const MOVING_MPH = 5;
export const STOPPED_MPH = 3;

export interface MotionEpisode {
  /** When the current uninterrupted movement began (null while not moving). */
  movingSinceMs: number | null;
  /** When the current uninterrupted stop began (null while not stopped). */
  stoppedSinceMs: number | null;
}

export const NO_EPISODE: MotionEpisode = { movingSinceMs: null, stoppedSinceMs: null };

/**
 * Steps the episode with a new speed. Between STOPPED_MPH and MOVING_MPH
 * (creeping in traffic) the episode simply continues - a slow stretch
 * doesn't end a drive, and doesn't start one. An unknown speed changes nothing.
 */
export function stepEpisode(state: MotionEpisode, speedMph: number | null, atMs: number): MotionEpisode {
  if (speedMph === null || !Number.isFinite(speedMph)) return state;
  if (speedMph >= MOVING_MPH) return { movingSinceMs: state.movingSinceMs ?? atMs, stoppedSinceMs: null };
  if (speedMph <= STOPPED_MPH) {
    const stoppedSinceMs = state.stoppedSinceMs ?? atMs;
    // A red light or a stop-and-go crawl is not the end of a drive:
    // a stop shorter than DIP_TOLERANCE_MS keeps the motion run (the
    // open-app detector has always done this; the feed path did not,
    // so city driving never held the 90 s the switch needs). The stop
    // is still recorded from its first fix, so the stop side keeps
    // its true start.
    const inDip = state.movingSinceMs !== null && atMs - stoppedSinceMs <= DIP_TOLERANCE_MS;
    return { movingSinceMs: inDip ? state.movingSinceMs : null, stoppedSinceMs };
  }
  return state;
}

// ---- when to propose ---------------------------------------------------------

/**
 * The per-capability switch for Telegram Live Location (ai-authority-matrix
 * gap G1). DEFAULT ON when no row exists: the feature is opt-in by the act of
 * sharing his live location in Telegram, and an absent row must not silently
 * break it. An explicit "off" row stops all storage and proposals.
 */
export const LIVE_LOCATION_CAPABILITY = "live_location";
/** Capabilities that are on unless a row says off (every other capability: no row = off). */
/**
 * The automatic switch to Driving (owner order 2026-11-06, "that's how they actually work in real
 * life"): a deterministic rule, not AI, but it changes his log on its own - so it has a kill switch.
 * Default ON (he ordered it); an explicit off row stops both the open-app and the position-feed paths.
 */
export const AUTO_DUTY_SWITCH_CAPABILITY = "auto_duty_switch";
export const DEFAULT_ON_CAPABILITIES: ReadonlySet<string> = new Set([LIVE_LOCATION_CAPABILITY, AUTO_DUTY_SWITCH_CAPABILITY]);

/** Moving this long while not logged driving earns a proposal. */
export const MOVING_PROPOSAL_AFTER_MS = 2 * 60_000;
/** Stopped this long while logged driving earns a proposal to go on/off duty. */
export const STOPPED_PROPOSAL_AFTER_MS = 5 * 60_000;
/** Never prompt more often than this, whatever the traffic does. */
export const PROPOSAL_COOLDOWN_MS = 30 * 60_000;
/**
 * Telegram review D6: a position fix older than this cannot support a
 * motion claim. The feed may have stalled, the phone may be off - a
 * "hasn't moved since 8:40 AM" built on a fix from hours ago is a
 * stale fact dressed as a current one. Mirrors the 10-min auto-switch
 * age gate (lib/auto-motion-rules.ts), with room for webhook delay.
 */
export const FRESH_FIX_MAX_AGE_MS = 15 * 60_000;

/** "just now" / "5 min ago" / "2 hours ago" / "3 days ago" - for stale-fix messages, never a raw timestamp. */
export function describeFixAge(ageMs: number): string {
  if (ageMs < 60_000) return "just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export type ProposalKind = "start_driving" | "stop_driving";

/**
 * What the last prompt was. "feed_stale" is not a proposal: it marks
 * the feed-health tell (ELD stopped vehicle §3.1) — a stale-feed tell
 * must never count as a prompt for the proposal cooldown, or a dead
 * feed would delay the first real proposal by 30 minutes once it
 * recovers.
 */
/** feed_stale: the stale-feed notice; rest_ask: "going off duty?" at 2 h parked (audit F-003). Neither is a duty proposal. */
export type LastPromptKind = ProposalKind | "feed_stale" | "rest_ask";

/** Stable identity of a movement episode (the mirror of the stop key in lib/stopped-vehicle.ts). */
export function moveEpisodeKey(movingSinceMs: number): string {
  return `move:${movingSinceMs}`;
}

export interface StatusProposal {
  kind: ProposalKind;
  /** The status to offer. */
  status: DutyStatus;
  /** When the movement/stop actually began - the time the logged row should carry. */
  sinceMs: number;
  /** Stop-episode / movement-episode identity (stop:<start> / move:<start>) — dedupe is by episode, not by exact millisecond. */
  episodeKey: string;
}

export function decideStatusProposal(input: {
  episode: MotionEpisode;
  nowMs: number;
  /** His latest logged status, or null if he has never logged one. */
  currentStatus: DutyStatus | null;
  lastPromptAtMs: number | null;
  lastPromptKind: LastPromptKind | null;
}): StatusProposal | null {
  const { episode, nowMs, currentStatus, lastPromptAtMs, lastPromptKind } = input;
  // A feed-stale tell or the rest question is not a duty proposal: neither holds the cooldown.
  const effectiveLastPromptAtMs = lastPromptKind === "feed_stale" || lastPromptKind === "rest_ask" ? null : lastPromptAtMs;
  if (effectiveLastPromptAtMs !== null && nowMs - effectiveLastPromptAtMs < PROPOSAL_COOLDOWN_MS) return null;

  if (episode.movingSinceMs !== null && nowMs - episode.movingSinceMs >= MOVING_PROPOSAL_AFTER_MS) {
    // Already driving: nothing to propose. Otherwise the truck is moving
    // and his log says he is not.
    if (currentStatus === "driving") return null;
    return { kind: "start_driving", status: "driving", sinceMs: episode.movingSinceMs, episodeKey: moveEpisodeKey(episode.movingSinceMs) };
  }

  if (episode.stoppedSinceMs !== null && nowMs - episode.stoppedSinceMs >= STOPPED_PROPOSAL_AFTER_MS) {
    // Only when the log still says driving: the truck has not moved for a
    // long time. On duty (not driving) is the safe offer - he can say
    // otherwise (off duty, sleeper) in his reply.
    if (currentStatus === "driving")
      return { kind: "stop_driving", status: "on_duty", sinceMs: episode.stoppedSinceMs, episodeKey: episodeKey(episode.stoppedSinceMs) };
  }
  return null;
}
