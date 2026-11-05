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

export function proposalText(p: StatusProposal, timeLabel: string): string {
  return p.kind === "start_driving"
    ? `Looks like you've been moving since ${timeLabel}, but your log doesn't say Driving. Want me to log ${STATUS_WORDS[p.status]} from ${timeLabel}? Reply yes, or tell me what it should be.`
    : `The truck hasn't moved since ${timeLabel} and your log still says Driving. Want me to log ${STATUS_WORDS[p.status]} from ${timeLabel}? Reply yes, or tell me what it should be (off duty, sleeper...).`;
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
  deps: { sendMessage: (text: string) => Promise<void>; formatTime: (ms: number) => string },
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
  const proposal = decideStatusProposal({
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
    const label = deps.formatTime(proposal.sinceMs);
    const text = proposalText(proposal, label);
    const sinceIso = new Date(proposal.sinceMs).toISOString();
    // Stage first, tell him second: a proposal he is told about must exist.
    await store.stageProposal(proposal, sinceIso, `Duty status: ${proposal.status} starting at ${sinceIso} (paper-log helper)`);
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

export function createLiveLocationStore(
  client: SupabaseClient,
  companyId: string,
  stage: (args: Record<string, unknown>, summary: string) => Promise<void>,
): LiveLocationStore {
  return {
    async loadPosition() {
      const { data, error } = await client
        .from("driver_positions").select("*")
        .eq("company_id", companyId).eq("source", "telegram").maybeSingle();
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
          company_id: companyId, source: "telegram",
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
export function createBrainLiveLocationStore(brain: BotBrainStore): LiveLocationStore {
  const tool = buildBotTools(brain).find((t) => t.name === "log_duty_status");
  return createLiveLocationStore(brain.client, brain.companyId, async (args, summary) => {
    if (!tool) throw new Error("log_duty_status tool missing");
    const checked = tool.validateArgs ? tool.validateArgs(args) : { ok: true as const, args };
    if (!checked.ok) throw new Error("proposal did not validate");
    await brain.savePendingAction({ toolName: "log_duty_status", args: checked.args as Record<string, unknown>, summary });
  });
}
