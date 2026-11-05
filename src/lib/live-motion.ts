// Background movement from Telegram Live Location (owner request
// 2026-11-05: tracking that works with the screen off). Pure.
// Telegram's own app streams the phone's position to the bot even when
// ours is closed. From those positions this derives speed, tracks movement
// and stop "episodes", and decides when Abel should PROPOSE a duty-status
// change - like an ELD's drive detection, but never booking anything: a
// proposal waits for his yes, and the time it carries is when the
// movement actually began.

import type { DutyStatus } from "@/types/entities";

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
  if (miles < JITTER_FLOOR_MILES) return 0;
  return miles / (dt / 3_600_000);
}

// ---- movement episodes -------------------------------------------------------

export const MOVING_MPH = 10;
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
  if (speedMph <= STOPPED_MPH) return { movingSinceMs: null, stoppedSinceMs: state.stoppedSinceMs ?? atMs };
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
export const DEFAULT_ON_CAPABILITIES: ReadonlySet<string> = new Set([LIVE_LOCATION_CAPABILITY]);

/** Moving this long while not logged driving earns a proposal. */
export const MOVING_PROPOSAL_AFTER_MS = 2 * 60_000;
/** Stopped this long while logged driving earns a proposal to go on/off duty. */
export const STOPPED_PROPOSAL_AFTER_MS = 20 * 60_000;
/** Never prompt more often than this, whatever the traffic does. */
export const PROPOSAL_COOLDOWN_MS = 30 * 60_000;

export type ProposalKind = "start_driving" | "stop_driving";

export interface StatusProposal {
  kind: ProposalKind;
  /** The status to offer. */
  status: DutyStatus;
  /** When the movement/stop actually began - the time the logged row should carry. */
  sinceMs: number;
}

export function decideStatusProposal(input: {
  episode: MotionEpisode;
  nowMs: number;
  /** His latest logged status, or null if he has never logged one. */
  currentStatus: DutyStatus | null;
  lastPromptAtMs: number | null;
  lastPromptKind: ProposalKind | null;
}): StatusProposal | null {
  const { episode, nowMs, currentStatus, lastPromptAtMs } = input;
  if (lastPromptAtMs !== null && nowMs - lastPromptAtMs < PROPOSAL_COOLDOWN_MS) return null;

  if (episode.movingSinceMs !== null && nowMs - episode.movingSinceMs >= MOVING_PROPOSAL_AFTER_MS) {
    // Already driving: nothing to propose. Otherwise the truck is moving
    // and his log says he is not.
    if (currentStatus === "driving") return null;
    return { kind: "start_driving", status: "driving", sinceMs: episode.movingSinceMs };
  }

  if (episode.stoppedSinceMs !== null && nowMs - episode.stoppedSinceMs >= STOPPED_PROPOSAL_AFTER_MS) {
    // Only when the log still says driving: the truck has not moved for a
    // long time. On duty (not driving) is the safe offer - he can say
    // otherwise (off duty, sleeper) in his reply.
    if (currentStatus === "driving") return { kind: "stop_driving", status: "on_duty", sinceMs: episode.stoppedSinceMs };
  }
  return null;
}
