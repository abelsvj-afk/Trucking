// ELD stopped-vehicle rules (brief §3, owner call 2026-11-14). Pure:
// the stop side of the ELD rule — prompt at 5 minutes stopped,
// auto-switch to On Duty Not Driving at minute 6 on silence
// (49 CFR Part 395, App. A §4.4.1.2). The thresholds are FIXED:
// the regulation says they "must not be configurable".
//
// What this module NEVER does: auto-switch to Off Duty or Sleeper
// Berth (§4.4.1.3 forbids any other automatic duty-status change),
// invent a stop from silence, or touch in-motion driving time.

import { STATIONARY_PROMPT_MS } from "./sustained-motion";
import type { DutyStatus } from "@/types/entities";

/** Stopped this long while logged Driving earns the prompt (the ELD number). */
export const STOP_PROMPT_MS = STATIONARY_PROMPT_MS;
/** Silence after the prompt before the auto-switch: prompt at 5, switch at 6. */
export const STOP_SILENCE_MS = 60_000;
/** Stopped this long with no answer: auto-switch to On Duty Not Driving. */
export const STOP_AUTO_SWITCH_MS = STOP_PROMPT_MS + STOP_SILENCE_MS;
/** After a stop proposal expires unanswered, re-prompt at most this often while still stopped. */
export const STOP_REPROMPT_MS = 60 * 60_000;
/** An unanswered stop proposal is dead after this (same as the bot's pending expiry). */
export const STOP_PROPOSAL_EXPIRY_MS = 2 * 60 * 60_000;
/** No fix for this long while the log says Driving: the feed is stale, say so — never guess a stop. */
export const FEED_STALE_MS = 15 * 60_000;
/** A position jump bigger than this, inside a corrected window, contradicts the correction (GPS jitter is ~0.01 mi). */
export const CORRECTION_JUMP_MILES = 0.05;

/** Stable identity of one stop episode: the stop start IS the key (a creep that restarts the episode gets a new one). */
export function episodeKey(stoppedSinceMs: number): string {
  return `stop:${stoppedSinceMs}`;
}

/** The minute-6 auto-switch is due: stopped 6 minutes, prompt already shown, a minute of silence since. */
export function stopAutoSwitchDue(input: {
  stoppedSinceMs: number | null;
  nowMs: number;
  currentStatus: DutyStatus | null;
  /** When the 5-minute prompt was shown for this episode (null = never prompted: never auto-switch blind). */
  promptedAtMs: number | null;
}): boolean {
  const { stoppedSinceMs, nowMs, currentStatus, promptedAtMs } = input;
  if (stoppedSinceMs === null || currentStatus !== "driving" || promptedAtMs === null) return false;
  if (nowMs - stoppedSinceMs < STOP_AUTO_SWITCH_MS) return false;
  return nowMs - promptedAtMs >= STOP_SILENCE_MS;
}

/**
 * The hourly re-prompt after an expired proposal: same episode
 * (same stop start — the ORIGINAL stop start carries forward),
 * last prompt at least an hour ago. A different stop start is a
 * different episode and is never gated by the old prompt.
 */
export function stopRepromptAllowed(input: {
  nowMs: number;
  lastPromptAtMs: number | null;
  lastPromptKind: string | null;
  previousSinceMs: number | null;
  currentSinceMs: number | null;
}): boolean {
  const { nowMs, lastPromptAtMs, lastPromptKind, previousSinceMs, currentSinceMs } = input;
  if (lastPromptKind !== "stop_driving" || lastPromptAtMs === null) return true;
  if (previousSinceMs === null || currentSinceMs === null || previousSinceMs !== currentSinceMs) return true;
  return nowMs - lastPromptAtMs >= STOP_REPROMPT_MS;
}

/**
 * The feed-health tell: no fix for 15 minutes while the log says
 * Driving. `alreadyTold` is true when a tell is already recorded
 * for this stale period (cleared when a fresh fix arrives) — one
 * message per stale period, never a repeat, never an invented stop.
 */
export function decideFeedHealthTell(input: {
  lastFixAtMs: number | null;
  nowMs: number;
  currentStatus: DutyStatus | null;
  alreadyTold: boolean;
}): boolean {
  const { lastFixAtMs, nowMs, currentStatus, alreadyTold } = input;
  if (lastFixAtMs === null || currentStatus !== "driving" || alreadyTold) return false;
  return nowMs - lastFixAtMs >= FEED_STALE_MS;
}

/**
 * Movement inside a corrected window: the last known fix was already
 * inside the window the app marked stopped, and the truck is now
 * somewhere else — it must have moved while the log said it hadn't.
 * A fix pair with a derivable speed is the normal "moved again" path,
 * not this flag; this catches the move hidden inside a fix gap.
 */
export function movedDuringCorrection(input: {
  prevFixAtMs: number;
  displacementMiles: number;
  /** The episode was stopped at the previous fix (a moving episode means the move was already seen). */
  wasStopped: boolean;
  correctionStartMs: number;
}): boolean {
  const { prevFixAtMs, displacementMiles, wasStopped, correctionStartMs } = input;
  if (!wasStopped) return false;
  if (prevFixAtMs < correctionStartMs) return false;
  return displacementMiles > CORRECTION_JUMP_MILES;
}

/** The confirmation line (brief §3.6): the 14-hour window is NOT rewound by fixing the status. */
export function stopCorrectionConfirmation(input: {
  windowEndLabel: string | null;
}): string {
  if (input.windowEndLabel) {
    return `Driving time fixed. Your 14-hour window still ends at ${input.windowEndLabel} — only rest moves that.`;
  }
  return "Driving time fixed. Your 14-hour window keeps running — only rest moves that.";
}
