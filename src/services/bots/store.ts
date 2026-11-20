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

export type ProposalKind =
  | "load-draft"
  | "load-shortlist"
  | "message-draft"
  | "record-draft"
  | "call-plan"
  | "invoice-draft"
  | "factoring-packet"
  | "other";
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

function serviceRoleClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey);
}

/** Shared service-role client for the bot team's read stores (Billing's invoice reads use it). */
export function botTeamServiceClient(): SupabaseClient | null {
  return serviceRoleClient();
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
  /**
   * Find one logged room message by chat + Telegram message id.
   * Used for reply attribution: a reply to a message Billing sent
   * is addressed to Billing even when the reply text never names
   * it. Returns null when the message was never logged (the room
   * log only holds messages this app sent or received).
   */
  findGroupMessage(
    telegramChatId: number,
    telegramMessageId: number,
  ): Promise<{ senderKind: string; senderRef: string; text: string } | null>;
  recordSpend(input: { botSlug: BotSlug; model: string; tier: "scan" | "rank"; estimatedCents: number }): Promise<void>;
  spentThisMonthCents(sinceIso: string): Promise<number>;
  loadBotMemories(botSlug: BotSlug): Promise<BotMemoryRow[]>;
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

    async findGroupMessage(telegramChatId, telegramMessageId) {
      const { data, error } = await client
        .from("bot_group_messages")
        .select("senderKind:sender_kind, senderRef:sender_ref, text")
        .eq("company_id", companyId)
        .eq("telegram_chat_id", telegramChatId)
        .eq("telegram_message_id", telegramMessageId)
        .maybeSingle();
      if (error) fail("findGroupMessage", error);
      if (!data) return null;
      return data as { senderKind: string; senderRef: string; text: string };
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
  };
}
