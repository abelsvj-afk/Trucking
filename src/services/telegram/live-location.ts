// Background movement from Telegram Live Location (docs/design/driver-usability.md §4).
// SERVER ONLY. Telegram's own app streams the phone's position to the bot
// with the screen off; each edited_message carries one fix. This keeps the
// latest fix, derives speed from the previous one, tracks the movement/stop
// episode, and - when the movement says his log is out of date - stages a
// duty-status PROPOSAL carrying the time the movement really began. It
// never books anything: the proposal waits for his yes (bot_pending_actions).

import { AUTO_REST_AFTER_MS, restAskedAtForPark } from "@/lib/auto-motion-rules";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import type { DutyStatus } from "@/types/entities";
import { buildBotTools } from "@/services/bot/tools";
import type { BotBrainStore } from "@/services/bot/store";
import { AUTO_SWITCH_GRACE_MS } from "@/lib/auto-switch";
import { SUSTAIN_MS } from "@/lib/sustained-motion";
import {
  autoStopSubmissionId,
  autoRestSubmissionId,
  type AutoRestResult,
  autoSubmissionId,
  autoSwitchNotice,
  type AutoMotionResult,
  type AutoStopResult,
} from "@/services/fleet/auto-motion";
import {
  timeZoneForPosition,
  zoneCrossingNotice,
} from "@/lib/display-zone";
import {
  decideStatusProposal,
  deriveSpeedMph,
  describeFixAge,
  FRESH_FIX_MAX_AGE_MS,
  haversineMiles,
  JITTER_FLOOR_MILES,
  MAX_SPEED_INTERVAL_MS,
  moveEpisodeKey,
  NO_EPISODE,
  stepEpisode,
  type LastPromptKind,
  type MotionEpisode,
  type PositionFix,
  type ProposalKind,
  type StatusProposal,
} from "@/lib/live-motion";
import {
  decideFeedHealthTell,
  episodeKey,
  movedDuringCorrection,
  stopAutoSwitchDue,
  stopRepromptAllowed,
} from "@/lib/stopped-vehicle";

export interface TelegramLocation {
  latitude: number;
  longitude: number;
  horizontal_accuracy?: number;
  heading?: number;
  live_period?: number;
}

export interface StoredPosition {
  fix: PositionFix;
  headingDeg: number | null;
  speedMph: number | null;
  episode: MotionEpisode;
  lastPromptAtMs: number | null;
  /** "feed_stale" marks the feed-health tell, not a proposal (it never holds the proposal cooldown). */
  lastPromptKind: LastPromptKind | null;
}

/** One staged (or expired) stop proposal, as the episode-dedupe reads it. */
export interface StopProposalRow {
  id: string;
  status: DutyStatus;
  startedAtIso: string;
  episodeKey: string;
  createdAtMs: number;
  expired: boolean;
}

export interface LiveLocationStore {
  loadPosition(): Promise<StoredPosition | null>;
  savePosition(p: StoredPosition): Promise<void>;
  /** His latest logged duty status, or null if none. */
  loadCurrentStatus(): Promise<DutyStatus | null>;
  /** Stages the proposal as a pending action awaiting his yes. Returns the proposal's group key (its pending row id), or null when the store could not report one - the caller maps the sent message to that key. */
  stageProposal(proposal: StatusProposal, sinceIso: string, summary: string): Promise<string | null>;
  /**
   * Telegram review D2: is this exact duty proposal already waiting
   * for his yes? The live-location path stages directly (it never
   * passes through reconcileProposals), so without this check every
   * cooldown window staged a FRESH identical row - the Nov 8 duty
   * proposal resurfacing on Nov 11. Optional: a store without it
   * stages as before.
   *
   * ELD stopped vehicle: matching is by STOP-EPISODE identity
   * (episodeKey) when one is given, falling back to the exact
   * duty_status + started_at match for legacy rows without a key.
   */
  hasWaitingDutyProposal?(status: DutyStatus, sinceIso: string, episodeKey?: string): Promise<boolean>;
  /**
   * ELD stopped vehicle: the latest OPEN stop proposal (a
   * log_duty_status row carrying an episode_key), or null. Lets a
   * re-staged proposal for the same physical stop REPLACE the
   * waiting one — carrying its ORIGINAL stop start — instead of
   * cloning it (PR #69 residual 1). Optional: absent = no replace.
   */
  findWaitingStopProposal?(): Promise<StopProposalRow | null>;
  /**
   * ELD stopped vehicle: the latest stop proposal for this episode
   * key, open OR soft-deleted (expired) — the hourly re-prompt's
   * ORIGINAL stop start after the 2-hour expiry. Optional: absent
   * = the re-prompt carries the current episode's stop start.
   */
  findLatestStopProposal?(episodeKey: string): Promise<StopProposalRow | null>;
  /**
   * ELD stopped vehicle: replace a waiting stop proposal with a new
   * one for the same stop (old row soft-deleted, new row staged),
   * returning the new row's group key. Optional: absent = the
   * caller stages a fresh proposal instead.
   */
  replaceStopProposal?(oldId: string, proposal: StatusProposal, sinceIso: string, summary: string): Promise<string | null>;
  /** ELD stopped vehicle: soft-delete every open stop proposal for this episode key (the auto-switch applied it — nothing left to ask). */
  clearStopProposal?(episodeKey: string): Promise<void>;
  /** ELD stopped vehicle: the newest duty row (for the moved-during-correction flag). Optional: absent = no flag. */
  loadLatestDutyRow?(): Promise<{ duty_status: DutyStatus; started_at: string; source: string | null; notes: string | null } | null>;
}

export type LiveLocationResult =
  | { kind: "ignored" }
  | { kind: "recorded"; proposed: StatusProposal | null };

const STATUS_WORDS: Record<DutyStatus, string> = {
  driving: "Driving",
  on_duty: "On duty",
  off_duty: "Off duty",
  sleeper: "Sleeper",
};

/** Mirrors PENDING_EXPIRY_MS in src/services/bot/agent-turn.ts (2h): a proposal older than this is dead. */
const PENDING_PROPOSAL_EXPIRY_MS = 2 * 60 * 60 * 1000;

/**
 * The duty proposal as a labeled card, not a wall of prose
 * (owner 2026-11-12: structured information arrives as a card).
 * 🕒 header + labeled Status / Since / Proposed lines, so the
 * detector reads it as an HOS card with Yes/No buttons; "Reply
 * YES" (uppercase) is what arms those buttons. Same question as
 * before, same facts — structured, not reworded.
 */
export function proposalText(p: StatusProposal, timeLabel: string): string {
  if (p.kind === "start_driving") {
    return [
      "🕒 Duty check — truck moving",
      "Status: log doesn't say Driving",
      `Moving since: ${timeLabel}`,
      `Proposed: log Driving from ${timeLabel}`,
      "Reply YES to confirm, or tell me what it should be.",
    ].join("\n");
  }
  return [
    "🕒 Duty check — truck stopped",
    "Status: log still says Driving",
    `Stopped since: ${timeLabel}`,
    `Proposed: log ${STATUS_WORDS[p.status]} from ${timeLabel}`,
    "Reply YES to apply — drafted from then until now — or tell me off duty / sleeper instead.",
  ].join("\n");
}

function validLocation(l: TelegramLocation): boolean {
  return (
    Number.isFinite(l.latitude) && Number.isFinite(l.longitude) &&
    Math.abs(l.latitude) <= 90 && Math.abs(l.longitude) <= 180
  );
}

/**
 * Handles one live-location fix. `atMs` is the fix time (Telegram's
 * edit_date when present, else now). An out-of-order or duplicate fix
 * (not newer than the stored one) is ignored.
 */
/**
 * Auto rest is checked at the 2-hour mark and then at most every 10 minutes per park - not on every 5-second fix
 * (a park he set On Duty himself would otherwise re-read the log all night). In-process; a restart just checks again.
 */
const autoRestTried = new Map<number, number>();
const AUTO_REST_RETRY_MS = 10 * 60_000;
/** "Going off duty?" asked, per park (stoppedSinceMs) — the fallback while the position row cannot hold it. */
const restAskedInProcess = new Map<number, number>();

export function autoRestDue(stoppedSinceMs: number, atMs: number): boolean {
  const last = autoRestTried.get(stoppedSinceMs);
  if (last !== undefined && atMs - last < AUTO_REST_RETRY_MS) return false;
  autoRestTried.set(stoppedSinceMs, atMs);
  if (autoRestTried.size > 50) autoRestTried.delete(autoRestTried.keys().next().value!);
  return true;
}

export async function handleLiveLocation(
  store: LiveLocationStore,
  loc: TelegramLocation,
  atMs: number,
  deps: {
    /**
     * D4: returns the Telegram ids of the message(s) sent (the
     * card's id, or one id per plain chunk) - the proposal send
     * site maps them to the staged group key. A dep that reports
     * no ids returns void, and the proposal goes unmapped.
     */
    sendMessage: (text: string) => Promise<number[] | void>;
    /**
     * D4: records that the sent message(s) rendered the staged
     * duty proposal. Absent = no mapping (the device feed's
     * notifier reports no ids, so its proposals stay unmapped -
     * quoting one gets the honest one-line answer).
     */
    recordQuoteTargets?: (messageIds: number[], groupKeys: string[]) => Promise<void>;
    /**
     * The proposal label for an instant, in the zone of the fix it
     * belongs to — the truck's zone, labeled ("7:40 AM CT"). The fix's
     * coordinates ride along so the formatter never has to guess the
     * zone from a stale position. Never a raw ISO string.
     */
    formatTime: (ms: number, lat: number, lng: number) => string;
    /**
     * The automatic switch to Driving (works with the app closed: Telegram keeps streaming the
     * position). Given the DETECTION time; returns what the shared rules decided. Absent = the
     * old behavior (a proposal he approves). The third argument is the
     * fix's zone, so the switch row and its note carry the zone where
     * the motion was detected. The fourth is the EVIDENCE time (the
     * fix's own timestamp): the rules judge the detection's freshness
     * against it, not against the server's wall clock — a Tracker
     * batch flushed after a dead zone would otherwise read as stale
     * on every fix and refuse forever (the episode never resets while
     * moving). Absent = the server's wall clock.
     */
    autoSwitch?: (detectedAtIso: string, submissionId: string, timeZone?: string, evidenceAtMs?: number) => Promise<AutoMotionResult>;
    /**
     * The automatic switch OUT of Driving (ELD stopped vehicle, App. A
     * §4.4.1.2): stopped 6 minutes, 5-minute prompt unanswered for a
     * minute -> switch to On Duty, backdated to the stop start.
     * promptedAtMs is when the prompt was shown for this episode;
     * the server refuses without it. Absent = prompt-only (no
     * auto-switch from the feed path).
     */
    autoStop?: (
      stoppedSinceIso: string,
      submissionId: string,
      promptedAtMs: number | null,
      timeZone?: string,
    ) => Promise<AutoStopResult>;
    /** Owner 2026-11-17: parked 2 h with no answer -> Off Duty from when he parked (services/fleet/auto-motion.ts). */
    autoRest?: (stoppedSinceIso: string, submissionId: string, timeZone: string | undefined, askedAtMs: number | null) => Promise<AutoRestResult>;
  },
  /** Test seam: the "now" the fix's age is judged against (default: real now). */
  opts?: { nowMs?: number },
): Promise<LiveLocationResult> {
  if (!validLocation(loc) || !Number.isFinite(atMs)) return { kind: "ignored" };
  const prev = await store.loadPosition();
  if (prev && atMs <= prev.fix.atMs) return { kind: "ignored" };

  const fix: PositionFix = {
    lat: loc.latitude,
    lng: loc.longitude,
    atMs,
    accuracyM: typeof loc.horizontal_accuracy === "number" ? loc.horizontal_accuracy : null,
  };
  const speedMph = deriveSpeedMph(prev?.fix ?? null, fix);
  // Telegram review D6: a feed gap breaks the episode's continuity.
  // Fixes more than the speed window apart say nothing about what
  // happened in between - the truck may have moved and stopped
  // again - so an episode that "began hours ago" restarts here
  // instead of driving a proposal from a stale start time.
  const episodeBase =
    prev && atMs - prev.fix.atMs > MAX_SPEED_INTERVAL_MS ? NO_EPISODE : (prev?.episode ?? NO_EPISODE);
  const episode = stepEpisode(episodeBase, speedMph, atMs);

  const currentStatus = await store.loadCurrentStatus();

  // The fix's age, judged once: a fresh fix clears the feed-stale
  // marker (the next stale period tells again); a stale fix never
  // drives a proposal (D6 below). A feed-stale tell is not a prompt,
  // so it never holds the proposal cooldown.
  const fixAgeMs = (opts?.nowMs ?? Date.now()) - atMs;
  const feedRecovered = prev?.lastPromptKind === "feed_stale" && fixAgeMs <= FRESH_FIX_MAX_AGE_MS;
  let lastPromptAtMs = feedRecovered ? null : (prev?.lastPromptAtMs ?? null);
  let lastPromptKind: LastPromptKind | null = feedRecovered ? null : (prev?.lastPromptKind ?? null);

  // Timezone transition (owner order 2026-11-11): the display zone
  // follows the truck. When this fix lands in a different zone than
  // the stored one, say so plainly ONCE — the next fix in the new zone
  // has prev == new, so the notice cannot repeat for one crossing.
  // Best-effort: a failed send must never fail the fix.
  const fixZone = timeZoneForPosition(fix.lat, fix.lng);
  if (prev) {
    const prevZone = timeZoneForPosition(prev.fix.lat, prev.fix.lng);
    const crossing = zoneCrossingNotice(prevZone, fixZone);
    if (crossing) {
      try {
        await deps.sendMessage(crossing);
      } catch (err) {
        console.error("[live-location] zone-crossing notice failed", err);
      }
    }
  }

  // ELD stopped vehicle: the correction was wrong if the truck moved
  // inside the window it marked stopped. The move hides inside a fix
  // gap (no derivable speed), so the evidence is the position jump:
  // the last known fix was already inside the corrected window and
  // the truck is now somewhere else. Flag it to the driver — never
  // silently keep a correction the feed contradicts. Best-effort: a
  // failed lookup never fails the fix. Fires once per stop→move
  // transition (the episode stops being "stopped" after the first
  // moving fix, so later fixes cannot repeat it).
  if (prev && prev.episode.stoppedSinceMs !== null && store.loadLatestDutyRow) {
    const displacementMiles = haversineMiles(prev.fix, fix);
    if (displacementMiles > JITTER_FLOOR_MILES) {
      try {
        const latestRow = await store.loadLatestDutyRow();
        const isAutoStopCorrection =
          latestRow?.duty_status === "on_duty" &&
          (latestRow.source === "auto_motion" || (latestRow.notes ?? "").includes("Auto-stop correction"));
        if (
          isAutoStopCorrection &&
          latestRow &&
          movedDuringCorrection({
            prevFixAtMs: prev.fix.atMs,
            displacementMiles,
            wasStopped: true,
            correctionStartMs: Date.parse(latestRow.started_at),
          })
        ) {
          const stopLabel = deps.formatTime(Date.parse(latestRow.started_at), fix.lat, fix.lng);
          await deps.sendMessage(
            `Flag: the truck seems to have moved during ${stopLabel}–now, which I marked On Duty (not driving). ` +
              `That correction may be wrong — check the log before you drive on it. (Mirror — not the legal ELD.)`,
          );
        }
      } catch (err) {
        console.error("[live-location] moved-during-correction check failed", err);
      }
    }
  }

  // Automatic switch (owner order 2026-11-06): moving for SUSTAIN_MS + the grace while the log says
  // otherwise -> switch to Driving, stamped at the DETECTION time (movement start + SUSTAIN_MS),
  // and tell him. The shared rules stand down for a manual choice. When the switch is off (kill
  // switch) or unavailable, the old proposal below still applies.
  let autoHandled = false;
  if (
    deps.autoSwitch &&
    currentStatus !== null &&
    currentStatus !== "driving" &&
    episode.movingSinceMs !== null &&
    atMs - episode.movingSinceMs >= SUSTAIN_MS + AUTO_SWITCH_GRACE_MS
  ) {
    const detectedAtMs = episode.movingSinceMs + SUSTAIN_MS;
    try {
      // The evidence time is the fix's own timestamp: the rules judge
      // the detection's freshness against it, not the server clock
      // (a batch flushed after a dead zone must not read as stale).
      const res = await deps.autoSwitch(new Date(detectedAtMs).toISOString(), autoSubmissionId(detectedAtMs), fixZone, atMs);
      // Only a switch that went through, a manual choice that won, or
      // a status that is already Driving needs no proposal. Any OTHER
      // refusal (a detection judged stale, a missing log) must NOT
      // swallow the fallback proposal — a missed switch that stays
      // silent is worse than one that asks.
      if (res.switched || res.reason === "manual_change_won" || res.reason === "already_driving") autoHandled = true;
      if (res.switched && !res.deduplicated && res.startedAt) {
        await store.savePosition({
          fix, headingDeg: typeof loc.heading === "number" ? loc.heading : null,
          speedMph, episode, lastPromptAtMs: atMs, lastPromptKind: "start_driving",
        });
        await deps.sendMessage(autoSwitchNotice(res.startedAt, fixZone));
        return { kind: "recorded", proposed: null };
      }
    } catch (err) {
      console.error("[live-location] auto switch failed", err);
    }
  }

  // ELD stopped vehicle (owner call 2026-11-14, ON): stopped 6
  // minutes, 5-minute prompt unanswered for a minute -> auto-switch
  // to On Duty Not Driving, backdated to the stop start. The prompt
  // is the staged stop proposal for THIS episode: without a waiting
  // proposal carrying this stop start, there was no prompt to be
  // silent about, so no switch — the proposal path below asks
  // instead. After the switch the waiting proposal is moot and is
  // cleared, so a later YES cannot double-book the same window.
  if (deps.autoStop && currentStatus === "driving" && episode.stoppedSinceMs !== null) {
    const stoppedSinceMs = episode.stoppedSinceMs;
    const stopSinceIso = new Date(stoppedSinceMs).toISOString();
    let promptedAtMs: number | null = null;
    let waitingKey: string | null = null;
    try {
      const waiting = await store.findWaitingStopProposal?.();
      if (waiting && waiting.startedAtIso === stopSinceIso) {
        promptedAtMs = lastPromptKind === "stop_driving" ? lastPromptAtMs : null;
        waitingKey = waiting.episodeKey;
      }
    } catch {
      // A lookup failure never blocks the proposal path below.
    }
    if (promptedAtMs !== null && stopAutoSwitchDue({ stoppedSinceMs, nowMs: atMs, currentStatus, promptedAtMs })) {
      try {
        const res = await deps.autoStop(stopSinceIso, autoStopSubmissionId(stoppedSinceMs), promptedAtMs, fixZone);
        if (res.switched) {
          if (waitingKey) {
            try {
              await store.clearStopProposal?.(waitingKey);
            } catch {
              // The correction landed; a stale waiting row is cleaned up by the expiry sweep.
            }
          }
          await store.savePosition({
            fix, headingDeg: typeof loc.heading === "number" ? loc.heading : null,
            speedMph, episode, lastPromptAtMs: atMs, lastPromptKind: "stop_driving",
          });
          if (!res.deduplicated && res.message) await deps.sendMessage(res.message);
          return { kind: "recorded", proposed: null };
        }
      } catch (err) {
        console.error("[live-location] auto stop failed", err);
      }
    }
  }

  // Auto Off Duty after 2 hours parked (owner 2026-11-17), ASKING FIRST (audit F-003): at 2 h the server asks
  // "going off duty?"; only an unanswered question leads to the rest being logged. Only ever follows the app's own
  // automatic row (see judgeAutoRest); his own On Duty stands and is never asked about.
  if (
    deps.autoRest &&
    (currentStatus === "on_duty" || currentStatus === "driving") &&
    episode.stoppedSinceMs !== null &&
    atMs - episode.stoppedSinceMs >= AUTO_REST_AFTER_MS &&
    autoRestDue(episode.stoppedSinceMs, atMs)
  ) {
    try {
      const stoppedSinceMs = episode.stoppedSinceMs;
      const askedAtMs = restAskedAtForPark(
        stoppedSinceMs,
        lastPromptKind === "rest_ask" ? lastPromptAtMs : (restAskedInProcess.get(stoppedSinceMs) ?? null),
      );
      const res = await deps.autoRest(new Date(stoppedSinceMs).toISOString(), autoRestSubmissionId(stoppedSinceMs), fixZone, askedAtMs);
      if (!res.switched && res.reason === "ask_first" && res.message) {
        // Remember the question first, so it is asked once per park.
        restAskedInProcess.set(stoppedSinceMs, atMs);
        if (restAskedInProcess.size > 50) restAskedInProcess.delete(restAskedInProcess.keys().next().value!);
        try {
          await store.savePosition({
            fix, headingDeg: typeof loc.heading === "number" ? loc.heading : null,
            speedMph, episode, lastPromptAtMs: atMs, lastPromptKind: "rest_ask",
          });
        } catch (err) {
          // Migration 00110 not applied: the in-process copy still holds the ask (a restart asks again, once).
          console.error("[live-location] could not save the rest question", err);
        }
        await deps.sendMessage(res.message);
        return { kind: "recorded", proposed: null };
      }
      if (res.switched) {
        await store.savePosition({
          fix, headingDeg: typeof loc.heading === "number" ? loc.heading : null,
          speedMph, episode, lastPromptAtMs: atMs, lastPromptKind: "stop_driving",
        });
        if (!res.deduplicated && res.message) await deps.sendMessage(res.message);
        return { kind: "recorded", proposed: null };
      }
    } catch (err) {
      console.error("[live-location] auto rest failed", err);
    }
  }

  const proposal = autoHandled && episode.movingSinceMs !== null ? null : decideStatusProposal({
    episode,
    nowMs: atMs,
    currentStatus,
    lastPromptAtMs,
    lastPromptKind,
  });

  let proposed: StatusProposal | null = null;
  if (proposal) {
    const sinceIso = new Date(proposal.sinceMs).toISOString();
    // Telegram review D6: a stale fix never drives a proposal. The
    // movement may be real, but the fix is old - say so plainly,
    // with its age, instead of presenting a days-old timestamp as
    // current. While the log says Driving the tell is the brief's
    // feed-health wording (zone-labelled last-fix time); otherwise
    // the old honest line. Once per stale period: the feed_stale
    // marker (cleared by a fresh fix) stops repeats, and it never
    // holds the proposal cooldown.
    if (fixAgeMs > FRESH_FIX_MAX_AGE_MS) {
      const alreadyTold = prev?.lastPromptKind === "feed_stale";
      await store.savePosition({
        fix, headingDeg: typeof loc.heading === "number" ? loc.heading : null,
        speedMph, episode, lastPromptAtMs: alreadyTold ? lastPromptAtMs : atMs, lastPromptKind: "feed_stale",
      });
      if (!alreadyTold) {
        await deps.sendMessage(
          currentStatus === "driving"
            ? `I haven't had a location fix since ${deps.formatTime(atMs, fix.lat, fix.lng)} — I can't tell whether you've stopped. Check the app or share live location again.`
            : `I don't have a fresh location — last fix ${describeFixAge(fixAgeMs)}. I won't guess your duty status from that.`,
        );
      }
      return { kind: "recorded", proposed: null };
    }
    // Telegram review D2: this exact proposal is already waiting
    // for his yes - stage nothing, say nothing new. The waiting
    // list surfaces it; a fresh row per cooldown window is how the
    // Nov 8 duty proposal kept resurfacing on Nov 11. ELD stopped
    // vehicle: matching is by stop-episode identity, not by exact
    // millisecond (PR #69 residual 1).
    //
    // The save keeps the ORIGINAL prompt time: lastPromptAtMs is
    // "when he was last prompted" (the staging), not "the last fix
    // that saw the waiting proposal" — the 30-minute cooldown and
    // the hourly re-prompt are both measured from the prompt, so
    // refreshing it here would push the post-expiry re-prompt an
    // hour later with every passing fix.
    if (await store.hasWaitingDutyProposal?.(proposal.status, sinceIso, proposal.episodeKey)) {
      await store.savePosition({
        fix, headingDeg: typeof loc.heading === "number" ? loc.heading : null,
        speedMph, episode, lastPromptAtMs, lastPromptKind,
      });
      return { kind: "recorded", proposed: null };
    }
    // ELD stopped vehicle: same physical stop, new episode key
    // (a creep restarted the episode) while the earlier proposal
    // is still waiting — REPLACE it, carrying the ORIGINAL stop
    // start, never clone it. Guard: no start_driving prompt has
    // intervened, so the truck has not driven in between.
    // After an expiry, re-prompt at most once an hour for the
    // SAME episode (the expired row's start is the original start).
    let effectiveProposal = proposal;
    let effectiveSinceIso = sinceIso;
    let replacedId: string | null = null;
    if (proposal.kind === "stop_driving") {
      let waiting: StopProposalRow | null = null;
      try {
        waiting = await store.findWaitingStopProposal?.() ?? null;
      } catch {
        waiting = null;
      }
      if (waiting && waiting.episodeKey !== proposal.episodeKey && lastPromptKind === "stop_driving") {
        effectiveProposal = { ...proposal, sinceMs: Date.parse(waiting.startedAtIso) };
        effectiveSinceIso = waiting.startedAtIso;
        replacedId = waiting.id;
      } else if (!waiting && lastPromptKind === "stop_driving" && lastPromptAtMs !== null) {
        let previous: StopProposalRow | null = null;
        try {
          previous = await store.findLatestStopProposal?.(proposal.episodeKey) ?? null;
        } catch {
          previous = null;
        }
        if (
          previous &&
          previous.startedAtIso === sinceIso &&
          !stopRepromptAllowed({
            nowMs: atMs,
            lastPromptAtMs,
            lastPromptKind,
            previousSinceMs: proposal.sinceMs,
            currentSinceMs: proposal.sinceMs,
          })
        ) {
          await store.savePosition({
            fix, headingDeg: typeof loc.heading === "number" ? loc.heading : null,
            speedMph, episode, lastPromptAtMs, lastPromptKind,
          });
          return { kind: "recorded", proposed: null };
        }
      }
    }
    // Stage first, tell him second: a proposal he is told about must exist.
    // The summary carries the LABELED time in the fix's zone — it is
    // quoted back to him when the proposal is re-surfaced, and a raw
    // ISO there is exactly the Nov 11 9:58 PM incident (a Nov 8
    // proposal quoted as "2026-11-08T13:40:37.858Z"). Never again.
    const label = deps.formatTime(effectiveProposal.sinceMs, fix.lat, fix.lng);
    const text = proposalText(effectiveProposal, label);
    const summary = `Duty status: ${effectiveProposal.status} starting at ${label} (paper-log helper)`;
    const groupKey =
      replacedId && store.replaceStopProposal
        ? await store.replaceStopProposal(replacedId, effectiveProposal, effectiveSinceIso, summary)
        : await store.stageProposal(effectiveProposal, effectiveSinceIso, summary);
    lastPromptAtMs = atMs;
    lastPromptKind = effectiveProposal.kind;
    proposed = effectiveProposal;
    // The cooldown must hold even if the send fails, so save before sending.
    await store.savePosition({
      fix, headingDeg: typeof loc.heading === "number" ? loc.heading : null,
      speedMph, episode, lastPromptAtMs, lastPromptKind,
    });
    const sentIds = await deps.sendMessage(text);
    // D4: quoting the duty proposal answers it - the quoted
    // message in the D4 evidence IS one of these. Best-effort:
    // a recording failure never fails the fix.
    if (groupKey && deps.recordQuoteTargets && Array.isArray(sentIds) && sentIds.length > 0) {
      try {
        await deps.recordQuoteTargets(sentIds, [groupKey]);
      } catch (err) {
        console.error("[live-location] failed to record quote targets", err instanceof Error ? err.message : err);
      }
    }
    return { kind: "recorded", proposed };
  }

  await store.savePosition({
    fix, headingDeg: typeof loc.heading === "number" ? loc.heading : null,
    speedMph, episode, lastPromptAtMs, lastPromptKind,
  });
  return { kind: "recorded", proposed };
}

// ---- Supabase-backed store --------------------------------------------------

interface PositionRow {
  lat: number; lng: number; accuracy_m: number | null; heading_deg: number | null;
  speed_mph: number | null; recorded_at: string; moving_since: string | null;
  stopped_since: string | null; last_prompt_at: string | null; last_prompt_kind: string | null;
}
const ms = (iso: string | null): number | null => (iso ? Date.parse(iso) : null);
const iso = (n: number | null): string | null => (n === null ? null : new Date(n).toISOString());

export type PositionSource = "telegram" | "device";

export function createLiveLocationStore(
  client: SupabaseClient,
  companyId: string,
  stage: (args: Record<string, unknown>, summary: string) => Promise<string | null>,
  /** Which feed this is: Telegram Live Location, or the native shell's device feed. Each keeps its own latest row. */
  source: PositionSource = "telegram",
): LiveLocationStore {
  return {
    async loadPosition() {
      const { data, error } = await client
        .from("driver_positions").select("*")
        .eq("company_id", companyId).eq("source", source).maybeSingle();
      if (error) throw new Error(error.message);
      const r = data as PositionRow | null;
      if (!r) return null;
      return {
        fix: { lat: r.lat, lng: r.lng, atMs: Date.parse(r.recorded_at), accuracyM: r.accuracy_m },
        headingDeg: r.heading_deg,
        speedMph: r.speed_mph,
        episode: { movingSinceMs: ms(r.moving_since), stoppedSinceMs: ms(r.stopped_since) },
        lastPromptAtMs: ms(r.last_prompt_at),
        lastPromptKind: (r.last_prompt_kind as LastPromptKind | null) ?? null,
      };
    },
    async savePosition(p) {
      const { error } = await client.from("driver_positions").upsert(
        {
          company_id: companyId, source,
          lat: p.fix.lat, lng: p.fix.lng, accuracy_m: p.fix.accuracyM,
          heading_deg: p.headingDeg, speed_mph: p.speedMph,
          recorded_at: new Date(p.fix.atMs).toISOString(),
          moving_since: iso(p.episode.movingSinceMs),
          stopped_since: iso(p.episode.stoppedSinceMs),
          last_prompt_at: iso(p.lastPromptAtMs), last_prompt_kind: p.lastPromptKind,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "company_id,source" },
      );
      if (error) throw new Error(error.message);
    },
    async loadCurrentStatus() {
      const { data, error } = await client
        .from("duty_logs").select("duty_status")
        .eq("company_id", companyId).is("deleted_at", null)
        .lte("started_at", new Date().toISOString())
        .order("started_at", { ascending: false }).limit(1);
      if (error) throw new Error(error.message);
      const row = (data as { duty_status: DutyStatus }[] | null)?.[0];
      return row?.duty_status ?? null;
    },
    async stageProposal(proposal, sinceIso, summary) {
      // D4: the group key is the pending row's id - the caller
      // maps the sent duty proposal to it. The episode key rides
      // in arguments so dedupe is by stop episode, not by exact
      // millisecond (ELD stopped vehicle; no new column needed).
      return stage({ duty_status: proposal.status, started_at: sinceIso, episode_key: proposal.episodeKey }, summary);
    },
    async hasWaitingDutyProposal(status, sinceIso, key) {
      try {
        const { data, error } = await client
          .from("bot_pending_actions")
          .select("id, arguments, created_at")
          .eq("company_id", companyId)
          .eq("tool_name", "log_duty_status")
          .is("deleted_at", null);
        if (error || !data) return false;
        // An expired row is already dead (the turn-start sweep drops
        // it) - it must not block a fresh proposal for the same duty.
        const cutoff = Date.now() - PENDING_PROPOSAL_EXPIRY_MS;
        return ((data as { arguments?: Record<string, unknown>; created_at?: string }[]) ?? []).some((row) => {
          if (row.created_at && Date.parse(row.created_at) < cutoff) return false;
          // Same stop episode (key) counts even when the stop start
          // moved by a millisecond; otherwise the exact legacy match.
          if (key && row.arguments?.episode_key === key) return true;
          return row.arguments?.duty_status === status && row.arguments?.started_at === sinceIso;
        });
      } catch {
        return false; // a lookup failure never blocks staging
      }
    },
    async findWaitingStopProposal() {
      try {
        const { data, error } = await client
          .from("bot_pending_actions")
          .select("id, arguments, created_at")
          .eq("company_id", companyId)
          .eq("tool_name", "log_duty_status")
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(20);
        if (error || !data) return null;
        const nowMs = Date.now();
        for (const row of data as PendingDutyRow[]) {
          const parsed = toStopProposalRow(row, nowMs);
          if (parsed && !parsed.expired) return parsed;
        }
        return null;
      } catch {
        return null;
      }
    },
    async findLatestStopProposal(key) {
      try {
        // No deleted_at filter: an EXPIRED row is the re-prompt's
        // original stop start.
        const { data, error } = await client
          .from("bot_pending_actions")
          .select("id, arguments, created_at, deleted_at")
          .eq("company_id", companyId)
          .eq("tool_name", "log_duty_status")
          .order("created_at", { ascending: false })
          .limit(20);
        if (error || !data) return null;
        const nowMs = Date.now();
        for (const row of data as PendingDutyRow[]) {
          const parsed = toStopProposalRow(row, nowMs);
          if (parsed && parsed.episodeKey === key) return parsed;
        }
        return null;
      } catch {
        return null;
      }
    },
    async replaceStopProposal(oldId, proposal, sinceIso, summary) {
      await client
        .from("bot_pending_actions")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", oldId);
      return stage(
        { duty_status: proposal.status, started_at: sinceIso, episode_key: proposal.episodeKey },
        summary,
      );
    },
    async clearStopProposal(key) {
      try {
        const { data, error } = await client
          .from("bot_pending_actions")
          .select("id, arguments")
          .eq("company_id", companyId)
          .eq("tool_name", "log_duty_status")
          .is("deleted_at", null);
        if (error || !data) return;
        const ids = (data as PendingDutyRow[])
          .filter((row) => (row.arguments as Record<string, unknown> | undefined)?.episode_key === key)
          .map((row) => row.id);
        if (ids.length === 0) return;
        await client
          .from("bot_pending_actions")
          .update({ deleted_at: new Date().toISOString() })
          .in("id", ids);
      } catch {
        // The correction landed; a stale waiting row is cleaned up by the expiry sweep.
      }
    },
    async loadLatestDutyRow() {
      try {
        const { data, error } = await client
          .from("duty_logs")
          .select("duty_status, started_at, source, notes")
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .order("started_at", { ascending: false })
          .limit(1);
        if (error || !data) return null;
        const row = (data as { duty_status: DutyStatus; started_at: string; source: string | null; notes: string | null }[] | null)?.[0];
        return row ?? null;
      } catch {
        return null;
      }
    },
  };
}

/** A bot_pending_actions row carrying a stop proposal, or null when it is not one. */
interface PendingDutyRow {
  id: string;
  arguments?: Record<string, unknown>;
  created_at?: string;
  deleted_at?: string | null;
}

function toStopProposalRow(row: PendingDutyRow, nowMs: number): StopProposalRow | null {
  const args = row.arguments ?? {};
  const key = typeof args.episode_key === "string" ? args.episode_key : null;
  if (!key || !key.startsWith("stop:")) return null;
  if (typeof args.started_at !== "string" || typeof args.duty_status !== "string") return null;
  const createdAtMs = row.created_at ? Date.parse(row.created_at) : 0;
  return {
    id: row.id,
    status: args.duty_status as DutyStatus,
    startedAtIso: args.started_at,
    episodeKey: key,
    createdAtMs,
    expired: Number.isFinite(createdAtMs) && nowMs - createdAtMs > PENDING_PROPOSAL_EXPIRY_MS,
  };
}

/**
 * The wired store: positions on the brain store's client, proposals staged
 * as `log_duty_status` pending actions after the tool's OWN argument check
 * (a proposal that would not validate is never stored).
 */
export function createBrainLiveLocationStore(brain: BotBrainStore, source: PositionSource = "telegram"): LiveLocationStore {
  const tool = buildBotTools(brain).find((t) => t.name === "log_duty_status");
  const store = createLiveLocationStore(brain.client, brain.companyId, async (args, summary) => {
    if (!tool) throw new Error("log_duty_status tool missing");
    const checked = tool.validateArgs ? tool.validateArgs(args) : { ok: true as const, args };
    if (!checked.ok) throw new Error("proposal did not validate");
    // D4: the row id is generated here so the caller can map the
    // sent duty proposal to this group (savePendingAction reports
    // no id of its own).
    const id = randomUUID();
    await brain.savePendingAction({ id, toolName: "log_duty_status", args: checked.args as Record<string, unknown>, summary });
    return id;
  }, source);
  // The brain's own pending rows are the source of truth here (the
  // raw client query above would see the same rows, but the store
  // method keeps the check in one place and testable).
  return {
    ...store,
    async hasWaitingDutyProposal(status, sinceIso, key) {
      try {
        const rows = await brain.loadOpenPendingRows();
        const cutoff = Date.now() - PENDING_PROPOSAL_EXPIRY_MS;
        return rows.some((row) => {
          if (row.tool_name !== "log_duty_status") return false;
          if (Date.parse(row.created_at) < cutoff) return false;
          const args = row.arguments as Record<string, unknown>;
          // Same stop episode (key) counts even when the stop start
          // moved by a millisecond; otherwise the exact legacy match.
          if (key && args?.episode_key === key) return true;
          return args?.duty_status === status && args?.started_at === sinceIso;
        });
      } catch {
        return false; // a lookup failure never blocks staging
      }
    },
  };
}

/**
 * The feed-health tell for a DEAD feed (ELD stopped vehicle §3.1):
 * no fix at all has arrived for 15 minutes while the log says
 * Driving. There is no scheduler in this codebase to fire it on a
 * timer, so the caller runs it best-effort on his next inbound
 * Telegram interaction (webhook route) — one message per stale
 * period, marked on the newest position row so it never repeats
 * until a fresh fix arrives. A tell, never an invented stop.
 * Returns true when a tell was sent. Never throws.
 */
export async function maybeSendFeedStaleTell(opts: {
  client: SupabaseClient;
  companyId: string;
  sendMessage: (text: string) => Promise<unknown>;
  formatTime: (ms: number, lat: number, lng: number) => string;
  nowMs?: number;
}): Promise<boolean> {
  const nowMs = opts.nowMs ?? Date.now();
  try {
    const [{ data: dutyRows }, { data: posRows }] = await Promise.all([
      opts.client
        .from("duty_logs")
        .select("duty_status")
        .eq("company_id", opts.companyId)
        .is("deleted_at", null)
        .order("started_at", { ascending: false })
        .limit(1),
      opts.client
        .from("driver_positions")
        .select("source, lat, lng, recorded_at, last_prompt_at, last_prompt_kind")
        .eq("company_id", opts.companyId)
        .order("recorded_at", { ascending: false })
        .limit(1),
    ]);
    const latest = (dutyRows as { duty_status: DutyStatus }[] | null)?.[0];
    const pos = (
      posRows as
        | { source: string; lat: number; lng: number; recorded_at: string; last_prompt_at: string | null; last_prompt_kind: string | null }[]
        | null
    )?.[0];
    if (!latest || !pos) return false;
    const lastFixAtMs = Date.parse(pos.recorded_at);
    if (
      !decideFeedHealthTell({
        lastFixAtMs,
        nowMs,
        currentStatus: latest.duty_status,
        alreadyTold: pos.last_prompt_kind === "feed_stale",
      })
    ) {
      return false;
    }
    await opts.sendMessage(
      `I haven't had a location fix since ${opts.formatTime(lastFixAtMs, pos.lat, pos.lng)} — I can't tell whether you've stopped. Check the app or share live location again.`,
    );
    await opts.client
      .from("driver_positions")
      .update({ last_prompt_at: new Date(nowMs).toISOString(), last_prompt_kind: "feed_stale" })
      .eq("company_id", opts.companyId)
      .eq("source", pos.source);
    return true;
  } catch (err) {
    console.error("[live-location] feed-stale tell failed", err);
    return false;
  }
}
