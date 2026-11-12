// Background movement from Telegram Live Location (docs/design/driver-usability.md §4).
// SERVER ONLY. Telegram's own app streams the phone's position to the bot
// with the screen off; each edited_message carries one fix. This keeps the
// latest fix, derives speed from the previous one, tracks the movement/stop
// episode, and - when the movement says his log is out of date - stages a
// duty-status PROPOSAL carrying the time the movement really began. It
// never books anything: the proposal waits for his yes (bot_pending_actions).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DutyStatus } from "@/types/entities";
import { buildBotTools } from "@/services/bot/tools";
import type { BotBrainStore } from "@/services/bot/store";
import { AUTO_SWITCH_GRACE_MS } from "@/lib/auto-switch";
import { SUSTAIN_MS } from "@/lib/sustained-motion";
import { autoSubmissionId, autoSwitchNotice, type AutoMotionResult } from "@/services/fleet/auto-motion";
import {
  timeZoneForPosition,
  zoneCrossingNotice,
} from "@/lib/display-zone";
import {
  decideStatusProposal,
  deriveSpeedMph,
  stepEpisode,
  type MotionEpisode,
  type PositionFix,
  type ProposalKind,
  type StatusProposal,
} from "@/lib/live-motion";

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
  lastPromptKind: ProposalKind | null;
}

export interface LiveLocationStore {
  loadPosition(): Promise<StoredPosition | null>;
  savePosition(p: StoredPosition): Promise<void>;
  /** His latest logged duty status, or null if none. */
  loadCurrentStatus(): Promise<DutyStatus | null>;
  /** Stages the proposal as a pending action awaiting his yes. */
  stageProposal(proposal: StatusProposal, sinceIso: string, summary: string): Promise<void>;
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
    "Reply YES to confirm, or tell me what it should be (off duty, sleeper...).",
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
export async function handleLiveLocation(
  store: LiveLocationStore,
  loc: TelegramLocation,
  atMs: number,
  deps: {
    sendMessage: (text: string) => Promise<void>;
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
     * the motion was detected.
     */
    autoSwitch?: (detectedAtIso: string, submissionId: string, timeZone?: string) => Promise<AutoMotionResult>;
  },
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
  const episode = stepEpisode(prev?.episode ?? { movingSinceMs: null, stoppedSinceMs: null }, speedMph, atMs);

  const currentStatus = await store.loadCurrentStatus();

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
      const res = await deps.autoSwitch(new Date(detectedAtMs).toISOString(), autoSubmissionId(detectedAtMs), fixZone);
      if (res.switched || res.reason !== "switched_off") autoHandled = true; // a manual choice is also "handled": no nagging proposal on top
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

  const proposal = autoHandled && episode.movingSinceMs !== null ? null : decideStatusProposal({
    episode,
    nowMs: atMs,
    currentStatus,
    lastPromptAtMs: prev?.lastPromptAtMs ?? null,
    lastPromptKind: prev?.lastPromptKind ?? null,
  });

  let lastPromptAtMs = prev?.lastPromptAtMs ?? null;
  let lastPromptKind = prev?.lastPromptKind ?? null;
  let proposed: StatusProposal | null = null;
  if (proposal) {
    const label = deps.formatTime(proposal.sinceMs, fix.lat, fix.lng);
    const text = proposalText(proposal, label);
    const sinceIso = new Date(proposal.sinceMs).toISOString();
    // Stage first, tell him second: a proposal he is told about must exist.
    // The summary carries the LABELED time in the fix's zone — it is
    // quoted back to him when the proposal is re-surfaced, and a raw
    // ISO there is exactly the Nov 11 9:58 PM incident (a Nov 8
    // proposal quoted as "2026-11-08T13:40:37.858Z"). Never again.
    await store.stageProposal(proposal, sinceIso, `Duty status: ${proposal.status} starting at ${label} (paper-log helper)`);
    lastPromptAtMs = atMs;
    lastPromptKind = proposal.kind;
    proposed = proposal;
    // The cooldown must hold even if the send fails, so save before sending.
    await store.savePosition({
      fix, headingDeg: typeof loc.heading === "number" ? loc.heading : null,
      speedMph, episode, lastPromptAtMs, lastPromptKind,
    });
    await deps.sendMessage(text);
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
  stage: (args: Record<string, unknown>, summary: string) => Promise<void>,
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
        lastPromptKind: (r.last_prompt_kind as ProposalKind | null) ?? null,
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
      await stage({ duty_status: proposal.status, started_at: sinceIso }, summary);
    },
  };
}

/**
 * The wired store: positions on the brain store's client, proposals staged
 * as `log_duty_status` pending actions after the tool's OWN argument check
 * (a proposal that would not validate is never stored).
 */
export function createBrainLiveLocationStore(brain: BotBrainStore, source: PositionSource = "telegram"): LiveLocationStore {
  const tool = buildBotTools(brain).find((t) => t.name === "log_duty_status");
  return createLiveLocationStore(brain.client, brain.companyId, async (args, summary) => {
    if (!tool) throw new Error("log_duty_status tool missing");
    const checked = tool.validateArgs ? tool.validateArgs(args) : { ok: true as const, args };
    if (!checked.ok) throw new Error("proposal did not validate");
    await brain.savePendingAction({ toolName: "log_duty_status", args: checked.args as Record<string, unknown>, summary });
  }, source);
}
