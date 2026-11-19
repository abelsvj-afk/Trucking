// Bot team data access (Phase 0 baseline; plan docs/bot-team-build-plan.md).
// Supabase access for the new bot-team tables (migration 00103).
// Same pattern as the Telegram store (services/telegram/store.ts):
// the webhook has no user session, so this uses the server-only
// service-role key scoped to the single company id from
// TELEGRAM_COMPANY_ID. Every query is additionally filtered by that
// company id in code. If the env isn't configured, the factory returns
// null and the bots run reduced (no proposals, no ledger — the group
// says so honestly) rather than failing.
//
// Row shapes are defined here, not in src/types/database.ts: the
// generated types do not include the new tables until `npm run
// db:generate-types` runs after migration 00103 is applied. Regenerate
// then; until then, these local interfaces are the contract.
//
// No silent failures: every method throws with context on error, and
// callers log loudly. The webhook answers 200 regardless — a failed
// store call must never turn into a Telegram retry storm.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { BotSlug } from "./registry";
import type { CheckCallKind } from "./tracker";

export type ProposalKind = "load-draft" | "load-shortlist" | "message-draft" | "record-draft" | "call-plan" | "other";
export type ProposalStatus = "proposed" | "approved" | "denied" | "expired";
export type ProposalDecision = "approved" | "denied";
export type LoadOutcome = "booked" | "skipped" | "cancelled" | "completed" | "disputed";

export interface ProposalRow {
  id: string;
  company_id: string;
  bot_slug: BotSlug;
  kind: ProposalKind;
  title: string;
  payload: Record<string, unknown>;
  source_ref: string | null;
  status: ProposalStatus;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

export interface LoadLedgerInput {
  loadRef: string;
  brokerName?: string | null;
  origin?: string | null;
  destination?: string | null;
  rateCentsPerLoadedMile?: number | null;
  loadedMiles?: number | null;
  deadheadMiles?: number | null;
  payCents?: number | null;
  fuelCents?: number | null;
  detentionCents?: number | null;
  outcome: LoadOutcome;
  notes?: string | null;
}

export interface BotMemoryRow {
  id: string;
  bot_slug: BotSlug;
  kind: "fact" | "rule" | "preference" | "correction" | "watch-out";
  content: string;
  source: string;
  created_at: string;
}

export interface GroupMessageInput {
  telegramChatId: number;
  telegramMessageId: number;
  senderKind: "owner" | "bot";
  senderRef: string;
  text: string;
  routedToBotSlug?: BotSlug | null;
}

/** One logged check call (migration 00105, bot_check_calls). load_ref is null when the message named no load — the text is the record. */
export interface CheckCallRow {
  id: string;
  company_id: string;
  load_ref: string | null;
  kind: CheckCallKind;
  place: string | null;
  note: string | null;
  event_at: string;
  created_at: string;
}

export interface CheckCallInput {
  loadRef?: string | null;
  kind: CheckCallKind;
  place?: string | null;
  note?: string | null;
  eventAt?: string;
}

/** One detention clock (migration 00105, bot_detention_clocks). started_at is arrival/appointment + free time; ended_at null while running. */
export interface DetentionClockRow {
  id: string;
  company_id: string;
  load_ref: string | null;
  stop_label: string;
  arrived_at: string;
  appointment_at: string | null;
  free_minutes: number;
  started_at: string;
  ended_at: string | null;
  created_at: string;
}

/** POD/BOL packet completeness for a load (migration 00105, bot_doc_packets). One row per load_ref; null load_ref is the current load. */
export interface DocPacketRow {
  id: string;
  company_id: string;
  load_ref: string | null;
  bol_received: boolean;
  pod_received: boolean;
  updated_at: string;
}

/**
 * One handoff between bots (migration 00105, bot_handoffs). The team
 * room's work queue: with Bot-to-Bot Communication Mode on, the target
 * bot also receives the room post itself; without the mode, this row is
 * what the target bot reads — the room post is only its visible face.
 * Single-writer ownership: only the bot the handoff names may claim it,
 * and only while it is still open. idempotency_key dedupes redelivery
 * of the same triggering event. depth caps handoff chains (see
 * MAX_HANDOFF_DEPTH in tracker.ts).
 */
export type HandoffStatus = "open" | "claimed" | "done";

export interface HandoffRow {
  id: string;
  company_id: string;
  from_bot: BotSlug;
  to_bot: BotSlug;
  title: string;
  payload: Record<string, unknown>;
  status: HandoffStatus;
  parent_id: string | null;
  depth: number;
  idempotency_key: string;
  claimed_by: string | null;
  created_at: string;
  claimed_at: string | null;
  done_at: string | null;
}

export interface HandoffInput {
  fromBot: BotSlug;
  toBot: BotSlug;
  title: string;
  payload: Record<string, unknown>;
  parentId?: string | null;
  depth: number;
  idempotencyKey: string;
}

function serviceRoleClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey);
}

export interface BotTeamStore {
  readonly companyId: string;
  createProposal(input: {
    botSlug: BotSlug;
    kind: ProposalKind;
    title: string;
    payload: Record<string, unknown>;
    sourceRef?: string | null;
  }): Promise<ProposalRow>;
  listOpenProposals(limit?: number): Promise<ProposalRow[]>;
  getProposal(id: string): Promise<ProposalRow | null>;
  /**
   * Decide a proposal. Refuses (returns the current row unchanged)
   * when it is no longer proposed — a redelivered "yes" can never
   * decide the same proposal twice.
   */
  decideProposal(id: string, decision: ProposalDecision, decidedBy: string): Promise<ProposalRow>;
  logAudit(input: {
    botSlug: BotSlug;
    actor: "bot" | "owner" | "system";
    action: string;
    targetRef?: string | null;
    detail?: Record<string, unknown>;
  }): Promise<void>;
  recordLoadOutcome(input: LoadLedgerInput): Promise<void>;
  ensureGroupRoom(telegramChatId: number, name?: string): Promise<void>;
  recordGroupMessage(input: GroupMessageInput): Promise<void>;
  recordSpend(input: { botSlug: BotSlug; model: string; tier: "scan" | "rank"; estimatedCents: number }): Promise<void>;
  spentThisMonthCents(sinceIso: string): Promise<number>;
  loadBotMemories(botSlug: BotSlug): Promise<BotMemoryRow[]>;
  /** Tracker: log a check call (picked up / en route / delivered / arrived / departed). */
  recordCheckCall(input: CheckCallInput): Promise<CheckCallRow>;
  listCheckCalls(limit?: number): Promise<CheckCallRow[]>;
  /** Tracker: start a detention clock. started_at is arrival/appointment + free_minutes. */
  startDetentionClock(input: {
    loadRef?: string | null;
    stopLabel: string;
    arrivedAt: string;
    appointmentAt?: string | null;
    freeMinutes: number;
  }): Promise<DetentionClockRow>;
  /** Tracker: the currently running detention clock, if any. */
  getOpenDetentionClock(): Promise<DetentionClockRow | null>;
  endDetentionClock(id: string, departedAt: string): Promise<DetentionClockRow>;
  /** Tracker: the POD/BOL packet state for a load (null = the current load). */
  getDocPacket(loadRef: string | null): Promise<DocPacketRow | null>;
  setDocPacket(input: { loadRef: string | null; bolReceived: boolean; podReceived: boolean }): Promise<DocPacketRow>;
  /**
   * Team room: who sent one group message, for reply-to routing — a
   * reply to a bot's message goes to that bot. Null when the message
   * was never logged (the room predates logging, or logging failed).
   */
  getGroupMessageSender(telegramChatId: number, telegramMessageId: number): Promise<string | null>;
  /** Team room: record a handoff as work for the target bot. The idempotency key dedupes a redelivered trigger — a second record with the same key returns the first row. */
  recordHandoff(input: HandoffInput): Promise<HandoffRow>;
  /** Team room: handoffs waiting for one bot, oldest first. */
  listOpenHandoffs(toBot: BotSlug, limit?: number): Promise<HandoffRow[]>;
  /**
   * Team room: claim a handoff. Single-writer ownership — only the
   * named bot claims, and only while it is still open. Returns the
   * current row unchanged when it is no longer open.
   */
  claimHandoff(id: string, byBot: BotSlug): Promise<HandoffRow>;
  /** Team room: mark a claimed handoff done. Returns the row unchanged unless it was claimed. */
  completeHandoff(id: string): Promise<HandoffRow>;
}

export function createBotTeamStore(companyId: string | null): BotTeamStore | null {
  if (!companyId) return null;
  const client = serviceRoleClient();
  if (!client) return null;

  const fail = (where: string, error: unknown): never => {
    throw new Error(`[bot-team] ${where} failed: ${error instanceof Error ? error.message : String(error)}`);
  };

  return {
    companyId,

    async createProposal(input) {
      const { data, error } = await client
        .from("bot_proposals")
        .insert({
          company_id: companyId,
          bot_slug: input.botSlug,
          kind: input.kind,
          title: input.title,
          payload: input.payload,
          source_ref: input.sourceRef ?? null,
          status: "proposed",
        })
        .select()
        .single();
      if (error || !data) fail("createProposal", error);
      return data as ProposalRow;
    },

    async listOpenProposals(limit = 20) {
      const { data, error } = await client
        .from("bot_proposals")
        .select("*")
        .eq("company_id", companyId)
        .eq("status", "proposed")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) fail("listOpenProposals", error);
      return (data ?? []) as ProposalRow[];
    },

    async getProposal(id) {
      const { data, error } = await client
        .from("bot_proposals")
        .select("*")
        .eq("company_id", companyId)
        .eq("id", id)
        .maybeSingle();
      if (error) fail("getProposal", error);
      return (data ?? null) as ProposalRow | null;
    },

    async decideProposal(id, decision, decidedBy) {
      const current = await this.getProposal(id);
      if (!current) {
        throw new Error(`[bot-team] decideProposal failed: proposal ${id} not found`);
      }
      // Idempotent: a proposal that is no longer proposed keeps its
      // first decision. A redelivered "yes" changes nothing.
      if (current.status !== "proposed") return current;
      const { data, error } = await client
        .from("bot_proposals")
        .update({ status: decision, decided_at: new Date().toISOString(), decided_by: decidedBy })
        .eq("company_id", companyId)
        .eq("id", id)
        .eq("status", "proposed")
        .select()
        .single();
      if (error || !data) fail("decideProposal", error);
      return data as ProposalRow;
    },

    async logAudit(input) {
      const { error } = await client.from("bot_audit_log").insert({
        company_id: companyId,
        bot_slug: input.botSlug,
        actor: input.actor,
        action: input.action,
        target_ref: input.targetRef ?? null,
        detail: input.detail ?? {},
      });
      if (error) fail("logAudit", error);
    },

    async recordLoadOutcome(input) {
      const { error } = await client.from("bot_load_ledger").insert({
        company_id: companyId,
        load_ref: input.loadRef,
        broker_name: input.brokerName ?? null,
        origin: input.origin ?? null,
        destination: input.destination ?? null,
        rate_cents_per_loaded_mile: input.rateCentsPerLoadedMile ?? null,
        loaded_miles: input.loadedMiles ?? null,
        deadhead_miles: input.deadheadMiles ?? null,
        pay_cents: input.payCents ?? null,
        fuel_cents: input.fuelCents ?? null,
        detention_cents: input.detentionCents ?? null,
        outcome: input.outcome,
        notes: input.notes ?? null,
      });
      if (error) fail("recordLoadOutcome", error);
    },

    async ensureGroupRoom(telegramChatId, name = "bot team") {
      const { error } = await client.from("bot_group_rooms").upsert(
        { telegram_chat_id: telegramChatId, company_id: companyId, name, status: "active" },
        { onConflict: "telegram_chat_id" },
      );
      if (error) fail("ensureGroupRoom", error);
    },

    async recordGroupMessage(input) {
      const { error } = await client.from("bot_group_messages").insert({
        company_id: companyId,
        telegram_chat_id: input.telegramChatId,
        telegram_message_id: input.telegramMessageId,
        sender_kind: input.senderKind,
        sender_ref: input.senderRef,
        text: input.text,
        routed_to_bot_slug: input.routedToBotSlug ?? null,
      });
      if (error) fail("recordGroupMessage", error);
    },

    async recordSpend(input) {
      const { error } = await client.from("bot_spend_ledger").insert({
        company_id: companyId,
        bot_slug: input.botSlug,
        model: input.model,
        tier: input.tier,
        estimated_cents: input.estimatedCents,
      });
      if (error) fail("recordSpend", error);
    },

    async spentThisMonthCents(sinceIso) {
      const { data, error } = await client
        .from("bot_spend_ledger")
        .select("estimated_cents")
        .eq("company_id", companyId)
        .gte("created_at", sinceIso);
      if (error) fail("spentThisMonthCents", error);
      return (data ?? []).reduce((sum: number, row: { estimated_cents: number }) => sum + row.estimated_cents, 0);
    },

    async loadBotMemories(botSlug) {
      const { data, error } = await client
        .from("bot_team_memories")
        .select("*")
        .eq("company_id", companyId)
        .eq("bot_slug", botSlug)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) fail("loadBotMemories", error);
      return (data ?? []) as BotMemoryRow[];
    },

    async recordCheckCall(input) {
      const { data, error } = await client
        .from("bot_check_calls")
        .insert({
          company_id: companyId,
          load_ref: input.loadRef ?? null,
          kind: input.kind,
          place: input.place ?? null,
          note: input.note ?? null,
          event_at: input.eventAt ?? new Date().toISOString(),
        })
        .select()
        .single();
      if (error || !data) fail("recordCheckCall", error);
      return data as CheckCallRow;
    },

    async listCheckCalls(limit = 20) {
      const { data, error } = await client
        .from("bot_check_calls")
        .select("*")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) fail("listCheckCalls", error);
      return (data ?? []) as CheckCallRow[];
    },

    async startDetentionClock(input) {
      const arrivedMs = Date.parse(input.arrivedAt);
      const apptMs = input.appointmentAt ? Date.parse(input.appointmentAt) : NaN;
      const baseMs = Number.isFinite(apptMs) ? Math.max(arrivedMs, apptMs) : arrivedMs;
      const startedAt = new Date(baseMs + input.freeMinutes * 60_000).toISOString();
      const { data, error } = await client
        .from("bot_detention_clocks")
        .insert({
          company_id: companyId,
          load_ref: input.loadRef ?? null,
          stop_label: input.stopLabel,
          arrived_at: input.arrivedAt,
          appointment_at: input.appointmentAt ?? null,
          free_minutes: input.freeMinutes,
          started_at: startedAt,
          ended_at: null,
        })
        .select()
        .single();
      if (error || !data) fail("startDetentionClock", error);
      return data as DetentionClockRow;
    },

    async getOpenDetentionClock() {
      const { data, error } = await client
        .from("bot_detention_clocks")
        .select("*")
        .eq("company_id", companyId)
        .is("ended_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail("getOpenDetentionClock", error);
      return (data ?? null) as DetentionClockRow | null;
    },

    async endDetentionClock(id, departedAt) {
      const { data, error } = await client
        .from("bot_detention_clocks")
        .update({ ended_at: departedAt })
        .eq("company_id", companyId)
        .eq("id", id)
        .is("ended_at", null)
        .select()
        .single();
      if (error || !data) fail("endDetentionClock", error);
      return data as DetentionClockRow;
    },

    async getDocPacket(loadRef) {
      const query = client.from("bot_doc_packets").select("*").eq("company_id", companyId);
      if (loadRef === null) {
        const { data, error } = await query.is("load_ref", null).order("updated_at", { ascending: false }).limit(1).maybeSingle();
        if (error) fail("getDocPacket", error);
        return (data ?? null) as DocPacketRow | null;
      }
      const { data, error } = await query.eq("load_ref", loadRef).order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (error) fail("getDocPacket", error);
      return (data ?? null) as DocPacketRow | null;
    },

    async setDocPacket(input) {
      const existing = await this.getDocPacket(input.loadRef);
      if (existing) {
        const { data, error } = await client
          .from("bot_doc_packets")
          .update({ bol_received: input.bolReceived, pod_received: input.podReceived, updated_at: new Date().toISOString() })
          .eq("company_id", companyId)
          .eq("id", existing.id)
          .select()
          .single();
        if (error || !data) fail("setDocPacket", error);
        return data as DocPacketRow;
      }
      const { data, error } = await client
        .from("bot_doc_packets")
        .insert({
          company_id: companyId,
          load_ref: input.loadRef,
          bol_received: input.bolReceived,
          pod_received: input.podReceived,
        })
        .select()
        .single();
      if (error || !data) fail("setDocPacket", error);
      return data as DocPacketRow;
    },

    async getGroupMessageSender(telegramChatId, telegramMessageId) {
      const { data, error } = await client
        .from("bot_group_messages")
        .select("sender_ref")
        .eq("company_id", companyId)
        .eq("telegram_chat_id", telegramChatId)
        .eq("telegram_message_id", telegramMessageId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail("getGroupMessageSender", error);
      return (data?.sender_ref as string | undefined) ?? null;
    },

    async recordHandoff(input) {
      const existing = await client
        .from("bot_handoffs")
        .select("*")
        .eq("company_id", companyId)
        .eq("idempotency_key", input.idempotencyKey)
        .maybeSingle();
      if (existing.error) fail("recordHandoff", existing.error);
      // A redelivered trigger returns the first row — the handoff is
      // recorded once, never twice.
      if (existing.data) return existing.data as HandoffRow;
      const { data, error } = await client
        .from("bot_handoffs")
        .insert({
          company_id: companyId,
          from_bot: input.fromBot,
          to_bot: input.toBot,
          title: input.title,
          payload: input.payload,
          status: "open",
          parent_id: input.parentId ?? null,
          depth: input.depth,
          idempotency_key: input.idempotencyKey,
          claimed_by: null,
        })
        .select()
        .single();
      if (error || !data) fail("recordHandoff", error);
      return data as HandoffRow;
    },

    async listOpenHandoffs(toBot, limit = 10) {
      const { data, error } = await client
        .from("bot_handoffs")
        .select("*")
        .eq("company_id", companyId)
        .eq("to_bot", toBot)
        .eq("status", "open")
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) fail("listOpenHandoffs", error);
      return (data ?? []) as HandoffRow[];
    },

    async claimHandoff(id, byBot) {
      const current = await client
        .from("bot_handoffs")
        .select("*")
        .eq("company_id", companyId)
        .eq("id", id)
        .maybeSingle();
      if (current.error) fail("claimHandoff", current.error);
      if (!current.data) throw new Error(`[bot-team] claimHandoff failed: handoff ${id} not found`);
      const row = current.data as HandoffRow;
      // Idempotent: a handoff that is no longer open keeps its first
      // claim. Two bots racing the same handoff cannot both own it —
      // the update below only lands while the row is still open.
      if (row.status !== "open") return row;
      const { data, error } = await client
        .from("bot_handoffs")
        .update({ status: "claimed", claimed_by: byBot, claimed_at: new Date().toISOString() })
        .eq("company_id", companyId)
        .eq("id", id)
        .eq("status", "open")
        .select()
        .single();
      if (error || !data) {
        // Lost the race: re-read and return whoever owns it now.
        const reread = await client.from("bot_handoffs").select("*").eq("company_id", companyId).eq("id", id).maybeSingle();
        if (reread.error || !reread.data) fail("claimHandoff", error);
        return reread.data as HandoffRow;
      }
      return data as HandoffRow;
    },

    async completeHandoff(id) {
      const current = await client
        .from("bot_handoffs")
        .select("*")
        .eq("company_id", companyId)
        .eq("id", id)
        .maybeSingle();
      if (current.error) fail("completeHandoff", current.error);
      if (!current.data) throw new Error(`[bot-team] completeHandoff failed: handoff ${id} not found`);
      const row = current.data as HandoffRow;
      if (row.status !== "claimed") return row;
      const { data, error } = await client
        .from("bot_handoffs")
        .update({ status: "done", done_at: new Date().toISOString() })
        .eq("company_id", companyId)
        .eq("id", id)
        .eq("status", "claimed")
        .select()
        .single();
      if (error || !data) fail("completeHandoff", error);
      return data as HandoffRow;
    },
  };
}
