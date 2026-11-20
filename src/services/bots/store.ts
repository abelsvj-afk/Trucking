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

export interface ComplianceDeadlineRow {
  id: string;
  company_id: string;
  kind: string;
  subject_ref: string | null;
  due_date: string | null;
  status: "filed" | "missing" | "unknown";
  source: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ComplianceDeadlineUpsert {
  kind: string;
  subjectRef?: string | null;
  dueDate?: string | null;
  status?: "filed" | "missing" | "unknown";
  source?: string | null;
  notes?: string | null;
}

/** One duty-log row, read-only for the Watchdog's HOS snapshot. */
export interface DutySegmentRow {
  duty_status: "off_duty" | "sleeper" | "driving" | "on_duty";
  started_at: string;
  location: string | null;
}

/** One open DVIR defect, read-only for the Watchdog's defect alerts. */
export interface OpenDefectRow {
  id: string;
  description: string;
  source: string;
  created_at: string;
}

export interface GroupMessageRow {
  id: string;
  telegram_message_id: number;
  sender_kind: "owner" | "bot";
  sender_ref: string;
  text: string;
  routed_to_bot_slug: string | null;
  created_at: string;
}

export interface BotAuditRow {
  id: string;
  bot_slug: string;
  actor: string;
  action: string;
  target_ref: string | null;
  detail: Record<string, unknown>;
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
  /**
   * Idempotency for the Auditor's flags (chat-scoped, bounded): has
   * an auditor_check with this check_key already been logged? Reads
   * only the 20 newest auditor_check rows and matches the key in
   * code — no exotic query syntax, and the read stays bounded.
   * The Auditor is the single writer of auditor_check entries.
   */
  hasAuditorCheck(checkKey: string): Promise<boolean>;
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
  /**
   * Write one row of a bot's own memory (bot_team_memories). This is
   * the write half of the shared brain: facts a bot learns, rules it
   * is given, corrections the owner makes, and the watch-outs the
   * corrections-learning derives (services/bots/learning.ts). A bot
   * only ever writes its OWN slug's rows — memory is per-bot even
   * though the reasoning is shared.
   */
  saveBotMemory(input: {
    botSlug: BotSlug;
    kind: BotMemoryRow["kind"];
    content: string;
    source?: string;
  }): Promise<BotMemoryRow>;
  /** Compliance Watchdog: the deadline checklist (migration 00105). */
  listComplianceDeadlines(): Promise<ComplianceDeadlineRow[]>;
  /**
   * File or update one deadline row (one writer per kind + subject).
   * Single-writer by code: read the existing row for the kind and
   * subject, then update it or insert it. No upsert constraint is
   * assumed — the migration carries the unique index as the backstop.
   */
  upsertComplianceDeadline(input: ComplianceDeadlineUpsert): Promise<ComplianceDeadlineRow>;
  /** Open DVIR defects from vehicle_defects — read-only. */
  listOpenDefects(): Promise<OpenDefectRow[]>;
  /** Most recent duty-log rows, newest first — read-only. */
  listRecentDutySegments(limit?: number): Promise<DutySegmentRow[]>;
  /**
   * Idempotency for alert posts: true when an alert with this
   * fingerprint was already posted (audit action
   * compliance_alert_posted) since `sinceIso`.
   */
  hasRecentAlert(fingerprint: string, sinceIso: string): Promise<boolean>;
  /**
   * Audit rows for one action since a moment, newest first. The
   * generic read behind handoffs, sweep claims, and bot-channel
   * bookkeeping (Watchdog team room, 2026-11-19).
   */
  listRecentAudit(input: { action: string; sinceIso: string; limit?: number }): Promise<BotAuditRow[]>;
  /**
   * Idempotency for any fingerprinted audit action: true when a row
   * with this action and detail.fingerprint exists since `sinceIso`.
   * Job claiming (sweep_claim) and once-a-day team handoffs ride on
   * this — the Postgres-side unique truth is the audit log itself.
   */
  hasRecentAuditFingerprint(input: { action: string; fingerprint: string; sinceIso: string }): Promise<boolean>;
  /**
   * Handoffs addressed TO one bot (audit action 'handoff',
   * detail.to = the bot), newest first. Validated state only —
   * summaries the receiving bot's next turn reads, never transcripts.
   */
  listHandoffsFor(input: { to: BotSlug; sinceIso: string; limit?: number }): Promise<BotAuditRow[]>;
  /**
   * The room's most recent logged messages, newest first. The
   * bot-to-bot channel reads this for redelivery dedupe and for the
   * consecutive-bot-message chain depth (loop safeguard).
   */
  listRecentGroupMessages(limit?: number): Promise<GroupMessageRow[]>;
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

    async hasAuditorCheck(checkKey) {
      const { data, error } = await client
        .from("bot_audit_log")
        .select("detail")
        .eq("company_id", companyId)
        .eq("bot_slug", "auditor")
        .eq("action", "auditor_check")
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) fail("hasAuditorCheck", error);
      const rows = (data ?? []) as { detail?: { check_key?: unknown } | null }[];
      return rows.some((row) => row.detail?.check_key === checkKey);
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

    async saveBotMemory(input) {
      const { data, error } = await client
        .from("bot_team_memories")
        .insert({
          company_id: companyId,
          bot_slug: input.botSlug,
          kind: input.kind,
          content: input.content,
          source: input.source ?? "bot",
        })
        .select()
        .single();
      if (error || !data) fail("saveBotMemory", error);
      return data as BotMemoryRow;
    },

    async listComplianceDeadlines() {
      const { data, error } = await client
        .from("bot_compliance_deadlines")
        .select("*")
        .eq("company_id", companyId)
        .order("kind", { ascending: true });
      if (error) fail("listComplianceDeadlines", error);
      return (data ?? []) as ComplianceDeadlineRow[];
    },

    async upsertComplianceDeadline(input) {
      const subjectRef = input.subjectRef ?? null;
      let query = client.from("bot_compliance_deadlines").select("*").eq("company_id", companyId).eq("kind", input.kind);
      query = subjectRef === null ? query.is("subject_ref", null) : query.eq("subject_ref", subjectRef);
      const { data: existing, error: readError } = await query.maybeSingle();
      if (readError) fail("upsertComplianceDeadline read", readError);
      const row = {
        company_id: companyId,
        kind: input.kind,
        subject_ref: subjectRef,
        due_date: input.dueDate ?? null,
        status: input.status ?? "filed",
        source: input.source ?? null,
        notes: input.notes ?? null,
        updated_at: new Date().toISOString(),
      };
      if (existing) {
        const { data, error } = await client
          .from("bot_compliance_deadlines")
          .update(row)
          .eq("company_id", companyId)
          .eq("id", (existing as ComplianceDeadlineRow).id)
          .select()
          .single();
        if (error || !data) fail("upsertComplianceDeadline update", error);
        return data as ComplianceDeadlineRow;
      }
      const { data, error } = await client.from("bot_compliance_deadlines").insert(row).select().single();
      if (error || !data) fail("upsertComplianceDeadline insert", error);
      return data as ComplianceDeadlineRow;
    },

    async listOpenDefects() {
      const { data, error } = await client
        .from("vehicle_defects")
        .select("id, description, source, created_at")
        .eq("company_id", companyId)
        .eq("status", "open")
        .is("deleted_at", null)
        .order("created_at", { ascending: true });
      if (error) fail("listOpenDefects", error);
      return (data ?? []) as OpenDefectRow[];
    },

    async listRecentDutySegments(limit = 10) {
      const { data, error } = await client
        .from("duty_logs")
        .select("duty_status, started_at, location")
        .eq("company_id", companyId)
        .is("deleted_at", null)
        .order("started_at", { ascending: false })
        .limit(limit);
      if (error) fail("listRecentDutySegments", error);
      return (data ?? []) as DutySegmentRow[];
    },

    async hasRecentAlert(fingerprint, sinceIso) {
      const { data, error } = await client
        .from("bot_audit_log")
        .select("id")
        .eq("company_id", companyId)
        .eq("action", "compliance_alert_posted")
        .gte("created_at", sinceIso)
        .filter("detail->>fingerprint", "eq", fingerprint)
        .limit(1);
      if (error) fail("hasRecentAlert", error);
      return (data ?? []).length > 0;
    },

    async listRecentAudit(input) {
      const { data, error } = await client
        .from("bot_audit_log")
        .select("*")
        .eq("company_id", companyId)
        .eq("action", input.action)
        .gte("created_at", input.sinceIso)
        .order("created_at", { ascending: false })
        .limit(input.limit ?? 20);
      if (error) fail("listRecentAudit", error);
      return (data ?? []) as BotAuditRow[];
    },

    async hasRecentAuditFingerprint(input) {
      const { data, error } = await client
        .from("bot_audit_log")
        .select("id")
        .eq("company_id", companyId)
        .eq("action", input.action)
        .gte("created_at", input.sinceIso)
        .filter("detail->>fingerprint", "eq", input.fingerprint)
        .limit(1);
      if (error) fail("hasRecentAuditFingerprint", error);
      return (data ?? []).length > 0;
    },

    async listHandoffsFor(input) {
      const { data, error } = await client
        .from("bot_audit_log")
        .select("*")
        .eq("company_id", companyId)
        .eq("action", "handoff")
        .gte("created_at", input.sinceIso)
        .filter("detail->>to", "eq", input.to)
        .order("created_at", { ascending: false })
        .limit(input.limit ?? 5);
      if (error) fail("listHandoffsFor", error);
      return (data ?? []) as BotAuditRow[];
    },

    async listRecentGroupMessages(limit = 25) {
      const { data, error } = await client
        .from("bot_group_messages")
        .select("*")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) fail("listRecentGroupMessages", error);
      return (data ?? []) as GroupMessageRow[];
    },
  };
}
