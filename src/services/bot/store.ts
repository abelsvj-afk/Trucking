// Bot intelligence v2 (docs/design/driver-mvp.md §8). The bot's
// data access, generalized from the v1 Telegram store: ONE store
// over one Supabase client + company scope, parameterized by
// channel ("telegram" | "web"). Both surfaces read and write the
// same telegram_messages timeline (company-wide, channel-tagged -
// migration 00015), the same bot_memories, and the same snapshot,
// so the web chat and the Telegram bot cannot diverge into two
// brains that know different things.
//
// The Telegram surface constructs this with the service-role client
// scoped to TELEGRAM_COMPANY_ID (the webhook has no session - the
// documented design §§5/6 exception). The web surface constructs it
// with the owner's session client, so RLS does the scoping there.

import { cycleLine, loadHosWindow } from "@/services/api/hos-window";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BOT_CHAT_CAPABILITY } from "@/services/ai/agent-loop";
import { DISPATCH_HELPER_CAPABILITY } from "@/services/ai/dispatch";
import { createMemoryStore } from "./store-memory";
import { createPayStore } from "./store-pay";
import { createThreadStore } from "./store-threads";
import { isMissingColumnError } from "./tool-helpers";
import { getEmbeddingProvider, toVectorLiteral, tryEmbed } from "./embeddings";
import { applySupersession } from "./memory-lifecycle";
import {
  type FactRetrieval,
  type RetrievedFact,
} from "./memory-retrieval";
import type { DispatchSuggestion } from "@/services/ai/dispatch";
import type { BotChatTurn } from "@/services/ai/bot-chat";
import type { TelegramStore } from "@/services/telegram/store";
import type { BotMemoryRow, CompanySnapshot } from "@/services/telegram/context";
import type { DutyLog } from "@/types/entities";
import type { PayPin } from "./pay-pin";
import {
  type PersonEvidence,
  type ThreadParticipant,
} from "./threads";
import { VOICE_TRANSCRIPTION_CAPABILITY } from "@/services/ai/transcription";
import {
  DRIVER_TWIN_CAPABILITY,
  editDistanceRatio,
  rankExemplars,
} from "./voice-corpus";
import {
  type SettlementFigures,
  type WeekLoad,
} from "./pay-truth";

export interface SettlementLineInput {
  kind: string;
  label: string;
  /** Signed cents: earnings positive, deductions negative. */
  amountCents: number;
  loadId?: string | null;
}

export interface SettlementRecordInput extends SettlementFigures {
  sourceDocumentId?: string | null;
  notes?: string | null;
  lines: SettlementLineInput[];
}

export interface StoredSettlement extends SettlementFigures {
  id: string;
  pinCheck: string;
  pinCheckDetail: string | null;
  createdAt: string;
}

export interface RecordedSettlement {
  id: string;
  pinCheck: string;
  pinCheckDetail: string | null;
  /** The code-computed true-pay lines (pay-truth.ts) - the only figures a reply may quote. */
  truePayLines: string[];
}

// --- Phase C types (threads) ---

export interface ThreadMessageInput {
  senderName: string;
  body: string;
  /** en | es | unknown - the message's own language. */
  language: string;
  sentAt?: string | null;
}

export interface ThreadRecordInput {
  title?: string | null;
  participants: import("./threads").ThreadParticipant[];
  messages: ThreadMessageInput[];
  theAsk?: string | null;
  askOf?: string | null;
  deadlineText?: string | null;
  unanswered: boolean;
  source: "forward" | "paste" | "photo" | "chat";
  exchangeId?: string | null;
}

export interface StoredThread {
  id: string;
  title: string | null;
  status: string;
  language: string | null;
  theAsk: string | null;
  askOf: string | null;
  deadlineText: string | null;
  participants: import("./threads").ThreadParticipant[];
  unanswered: boolean;
  updatedAt: string;
  createdAt: string;
}

export interface StoredThreadMessage {
  id: string;
  senderName: string;
  senderRole: string | null;
  body: string;
  language: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface RecordedThread {
  threadId: string;
  /** True when the segment appended to an existing open thread (code-matched), false when it started a new one. */
  appended: boolean;
  messageCount: number;
}

export type BotChannel = "telegram" | "web";

export interface PendingAction {
  id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  summary: string;
  channel: BotChannel;
  created_at: string;
  /** §9 dump batches (migration 00021) - null on plain §8 proposals, and null everywhere until 00021 is applied. */
  batch_id: string | null;
  item_number: number | null;
  source_quote: string | null;
  confidence: string | null;
}

export interface BotBrainStore extends TelegramStore {
  readonly client: SupabaseClient;
  readonly companyId: string;
  readonly channel: BotChannel;
  /** The shared timeline: recent turns across BOTH channels, oldest first. */
  loadConversationHistory(limit?: number): Promise<BotChatTurn[]>;
  saveConversationMessage(role: "user" | "assistant", text: string): Promise<void>;
  /** The TARGET of a bare yes/no: the most recently shown pending proposal (not the oldest). */
  loadPendingAction(): Promise<PendingAction | null>;
  /** Silently drops proposals created before the cutoff (never photo asks, which expire by their own rule), except the group with `keepKey`. Returns how many rows were dropped. */
  dropExpiredPending(cutoffIso: string, keepKey?: string | null): Promise<number>;
  /** Every open proposal (a dump batch counts once), oldest first - used to ask "which one?" when it is unclear. */
  loadOpenPendingGroups(): Promise<{ key: string; toolName: string; summary: string; createdAt: string }[]>;
  /** §9: every pending item of the oldest pending dump batch (empty when the oldest pending proposal is a single, or none is pending). */
  loadPendingBatch(): Promise<PendingAction[]>;
  savePendingAction(action: {
    toolName: string;
    args: Record<string, unknown>;
    summary: string;
    batchId?: string;
    itemNumber?: number;
    sourceQuote?: string;
    confidence?: string;
  }): Promise<void>;
  /** §9: rewrite a stored proposal's arguments + summary (the revise_pending_item path - a correction before approval). */
  updatePendingAction(id: string, args: Record<string, unknown>, summary: string): Promise<void>;
  clearPendingAction(id: string): Promise<void>;
  clearPendingActions(ids: string[]): Promise<void>;
  /** The bot_chat kill switch (docs/governance.md): global switch first, then per-capability, no row = off. */
  isBotChatEnabled(): Promise<boolean>;
  /** The dispatch_helper kill switch, same convention - Lane 1 (audit B-1): the Telegram dispatch path must honor it exactly like the web surfaces do. */
  isDispatchHelperEnabled(): Promise<boolean>;
  /**
   * Lane 1 (audit B-2): claims a Telegram update_id for processing.
   * Resolves true when this caller is the FIRST to claim it (proceed)
   * and false when it was already claimed (a redelivery - the caller
   * must not process it again). Backed by telegram_processed_updates
   * (migration 00033); before that migration lands it resolves true
   * (dedup inactive, historical behavior) rather than failing turns.
   * A successful claim also opportunistically prunes claims older
   * than 30 days (pitfall hunt CD-9 - the table otherwise only grows).
   */
  claimTelegramUpdate(updateId: number): Promise<boolean>;
  /**
   * Fix round (pitfall hunt CD-6): releases a claim whose turn did
   * NOT complete (the reply send failed and the error escaped), so
   * Telegram's redelivery of that update is processed instead of
   * being swallowed as a duplicate. Best-effort by contract: the
   * caller logs loudly when this rejects. Before migration 00033
   * there is no claim table - releasing is a silent no-op.
   */
  releaseTelegramUpdate(updateId: number): Promise<void>;
  // --- Lane 2 (Abel Intelligence Upgrade, Phases A+B) ---
  /** Hybrid retrieval over ALL current facts (design §3.5) - the context-assembly path that replaces loadMemories+keyword-pick. */
  retrieveFacts(query: string): Promise<FactRetrieval>;
  /** ALL standing instructions (procedural memory is never relevance-filtered and never windowed). */
  loadInstructionMemories(): Promise<RetrievedFact[]>;
  /** The newest rolling conversation summary, when the night shift has produced one (migration 00032; null before it / when none). */
  loadLatestSummary(): Promise<{ weekStart: string; summary: string } | null>;
  /** The logging_reminders switch (proactive Telegram reminders): no row = off. */
  isLoggingRemindersEnabled(): Promise<boolean>;
  /** The live_location switch: default ON when no row exists; an explicit off row, the global switch, or an unverifiable read stops it. */
  isLiveLocationEnabled(): Promise<boolean>;
  /** The memory_consolidation kill switch (the night shift), same convention as every capability. */
  isMemoryConsolidationEnabled(): Promise<boolean>;
  /** The photo_intelligence kill switch (Image Intelligence design §3.4): off = photos behave exactly as the pre-feature intake. */
  isPhotoIntelligenceEnabled(): Promise<boolean>;
  /** The maintenance_watch kill switch (Image Intelligence design §5.6): off = the background watcher never runs and never messages; maintenance answers still work (they don't come through the watch). */
  isMaintenanceWatchEnabled(): Promise<boolean>;
  /** "What Abel remembers" surface: current memories, plus superseded history when asked. */
  listMemories(options?: { includeHistory?: boolean; limit?: number }): Promise<(RetrievedFact & { valid_to: string | null; superseded_by: string | null })[]>;
  /** Owner edit = supersede-with-correction (design §3.4: rows are never edited in place). Resolves the NEW row's id. */
  editMemory(id: string, content: string): Promise<string>;
  /** Owner delete = the store's existing soft delete. */
  deleteMemory(id: string): Promise<void>;
  // --- Abel Intelligence Upgrade, Phase D (pay truth) ---
  /** The pay pin: the current "Pay structure" business_fact, parsed. UNKNOWN_PIN when none exists - never a guess. */
  loadPayPin(): Promise<PayPin>;
  /** Records a settlement (header + lines + load links) with its code-computed true-pay figures and pin-check verdict (migration 00048). Throws a plain error when the migration hasn't landed. */
  recordSettlement(input: SettlementRecordInput): Promise<RecordedSettlement>;
  /** Recent settlements, newest period first. Empty before migration 00048 lands (reads degrade; writes fail loudly). */
  listSettlements(limit?: number): Promise<StoredSettlement[]>;
  /** Settlements whose period overlaps [startDate, endDate] (YYYY-MM-DD), for the weekly report. */
  listSettlementsInRange(startDate: string, endDate: string): Promise<StoredSettlement[]>;
  /** Completed loads delivered inside [startDate, endDate] - the weekly report's own-authority comparison reads these grosses. */
  listCompletedLoadsInRange(startDate: string, endDate: string): Promise<WeekLoad[]>;
  /** The weekly-pay-report run marker for one week (migration 00048); null before the migration / before that week's run. closedEmpty = the week was closed silently with no settlements (figures flag) - distinct from a failed send. */
  payReportRunForWeek(weekStart: string): Promise<{ weekStart: string; sent: boolean; closedEmpty: boolean; createdAt: string } | null>;
  /** Records a weekly-pay-report run (sent = the notifier actually delivered it). */
  recordPayReportRun(weekStart: string, sent: boolean, figures: Record<string, unknown>): Promise<void>;
  // --- Abel Intelligence Upgrade, Phase C (threads + people) ---
  /** Records a reconstructed forward thread (migration 00049): appends to the matching open thread when code finds one (participant overlap), else creates it. Throws a plain error when the migration hasn't landed. */
  recordForwardThread(input: ThreadRecordInput): Promise<RecordedThread>;
  /** Threads (newest activity first), optionally only open ones / only open loops. Empty before migration 00049 (reads degrade; writes fail loudly). */
  listThreads(options?: { openOnly?: boolean; unansweredOnly?: boolean; limit?: number }): Promise<StoredThread[]>;
  /** One thread + its verbatim timeline; null when absent (or before 00049). */
  getThread(threadId: string): Promise<{ thread: StoredThread; messages: StoredThreadMessage[] } | null>;
  /** Marks a thread's ask answered (the loop closes; the thread stays open for follow-ups). */
  markThreadAnswered(threadId: string): Promise<void>;
  /** Closes a thread outright (no more appends; follow-ups start a new thread). */
  closeThread(threadId: string): Promise<void>;
  /** The newest dispatch exchange whose incoming text matches - the thread<->exchange voice-corpus link. */
  findExchangeIdByIncoming(incoming: string): Promise<string | null>;
  /** Everything the per-person model may be built from for one name: confirmed profile, thread appearances, their message bodies, exchange mentions. */
  loadPersonEvidence(name: string): Promise<import("./threads").PersonEvidence>;
  /** The owner's "Life phase" business_fact override text, when he has set one (Phase C life-phase block). */
  loadLifePhaseOverride(): Promise<string | null>;
  /** The employer on his active pay-terms row (migration 00063), or null when none is stored - the situation text reads this instead of naming anyone in code. */
  loadActiveEmployer(): Promise<string | null>;
  /** The owner's own display name from his stored profile (user_profiles), or null when none is set - prompts read this instead of naming him in code. */
  loadOwnerName(): Promise<string | null>;
  // --- Abel Intelligence Upgrade, Phase E (voice + twin) ---
  /** The voice_transcription kill switch (Settings), same convention as every capability: no row = off. */
  isVoiceTranscriptionEnabled(): Promise<boolean>;
  /** The driver_twin kill switch (Settings) - DEFAULT OFF by the owner's ruling (design §9 decision 4): no row = off. */
  isDriverTwinEnabled(): Promise<boolean>;
  /** Draft-time exemplars: his actual sent replies from exchanges resembling this incoming message (ranked in code). Empty when the corpus has nothing similar - or nothing at all. */
  loadVoiceExemplars(incomingText: string): Promise<import("./voice-corpus").VoiceExemplar[]>;
  /** Captures what he ACTUALLY sent for one exchange and computes the draft edit distance in code (migration 00050). Throws a plain error before 00050 lands. */
  recordSentReply(exchangeId: string, actualReply: string): Promise<{ editDistanceRatio: number | null }>;
  /** Recent dispatch exchanges (for targeting recordSentReply). */
  listRecentExchanges(limit?: number): Promise<{ id: string; incoming: string; hasDraft: boolean; actualReplySent: string | null; editDistanceRatio: number | null; createdAt: string }[]>;
  /** Logs one of HIS load decisions (taken/passed + outcome) - the decision-log pattern source. */
  recordLoadDecision(input: { loadId?: string | null; description: string; decision: "taken" | "passed"; outcomeNote?: string | null }): Promise<void>;
  /** His logged load decisions, newest first (bounded). */
  listLoadDecisions(limit?: number): Promise<{ id: string; loadId: string | null; description: string; decision: string; outcomeNote: string | null; createdAt: string }[]>;
  /** Twin measurement over a window: captured replies + their mean edit distance (null avg when none/unmeasured). */
  twinEditStats(fromIso: string, toIso: string): Promise<{ count: number; avgDistance: number | null }>;
  /**
   * Wider save (Lane 2): resolves the new row's id (null when the
   * insert couldn't return it) and accepts lifecycle options. The
   * base TelegramStore signature stays (kind, content) - this
   * overload is what the agent tools and admin surface call.
   */
  saveMemory(
    kind: BotMemoryRow["kind"],
    content: string,
    options?: { supersedesId?: string; provenance?: string },
  ): Promise<string | null>;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** CD-9: dedup claims older than this are pruned opportunistically on claim (a redelivery never arrives this late; the row is pure history by then). */
const PROCESSED_UPDATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Prune at most once an hour per process - claims are frequent, retention is not urgent. */
const PROCESSED_UPDATE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastProcessedUpdatePruneAt = 0;

export function createBotStore(
  supabase: SupabaseClient,
  companyId: string,
  channel: BotChannel,
): BotBrainStore {
  const company = companyId;

  async function contacts(table: "brokers" | "customers" | "drivers") {
    const [rows, countResult] = await Promise.all([
      supabase.from(table).select("name").eq("company_id", company).is("deleted_at", null).limit(25),
      supabase.from(table).select("id", { count: "exact", head: true }).eq("company_id", company).is("deleted_at", null),
    ]);
    if (rows.error) throw new Error(rows.error.message);
    const names = ((rows.data ?? []) as { name: string }[]).map((r) => r.name);
    return { names, total: countResult.count ?? names.length };
  }

  async function loadHistoryRows(limit: number): Promise<BotChatTurn[]> {
    // Company-wide on purpose (§8): the timeline is the conversation,
    // whichever window he typed it through. chat_id no longer scopes
    // reads - it is provenance only.
    const { data, error } = await supabase
      .from("telegram_messages")
      .select("role, text")
      .eq("company_id", company)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return ((data ?? []) as BotChatTurn[]).reverse();
  }

  const PENDING_BASE_COLUMNS = "id, tool_name, arguments, summary, channel, created_at";
  const PENDING_BATCH_COLUMNS = `${PENDING_BASE_COLUMNS}, batch_id, item_number, source_quote, confidence`;

  /**
   * Pending rows grouped into what the owner sees as ONE proposal (a dump
   * batch is one group; a single proposal is its own), ordered oldest first
   * by the group's newest row. A bare yes/no targets the LAST group - what
   * was most recently shown - never the oldest (Trip 1234 audit, P1).
   */
  function groupPending(rows: PendingAction[]): PendingAction[][] {
    const groups = new Map<string, PendingAction[]>();
    for (const row of rows) {
      const key = row.batch_id ?? row.id;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }
    const list = [...groups.values()].map((g) => g.sort((a, b) => (a.item_number ?? 0) - (b.item_number ?? 0)));
    return list.sort((a, b) => Date.parse(newestCreatedAt(a)) - Date.parse(newestCreatedAt(b)));
  }
  function newestCreatedAt(group: PendingAction[]): string {
    return group.reduce((m, r) => (r.created_at > m ? r.created_at : m), group[0]!.created_at);
  }
  async function targetGroup(): Promise<PendingAction[] | null> {
    const groups = groupPending(await loadPendingRows());
    return groups.length > 0 ? groups[groups.length - 1]! : null;
  }

  async function loadPendingRows(): Promise<PendingAction[]> {
    const runQuery = (columns: string) =>
      supabase
        .from("bot_pending_actions")
        .select(columns)
        .eq("company_id", company)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .limit(50);
    let result = await runQuery(PENDING_BATCH_COLUMNS);
    if (result.error && isMissingColumnError(result.error)) {
      // Graceful absence (design §9): migration 00021 not applied
      // yet - §8 single-proposal behavior is unaffected.
      result = await runQuery(PENDING_BASE_COLUMNS);
    }
    if (result.error) throw new Error(result.error.message);
    return ((result.data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      tool_name: String(row.tool_name),
      arguments: (row.arguments ?? {}) as Record<string, unknown>,
      summary: String(row.summary),
      channel: row.channel as BotChannel,
      created_at: String(row.created_at),
      batch_id: typeof row.batch_id === "string" ? row.batch_id : null,
      item_number: typeof row.item_number === "number" ? row.item_number : null,
      source_quote: typeof row.source_quote === "string" ? row.source_quote : null,
      confidence: typeof row.confidence === "string" ? row.confidence : null,
    }));
  }

  return {
    client: supabase,
    companyId: company,
    channel,

    // --- TelegramStore surface (v1 signatures kept; chatId is
    // provenance on writes and ignored for read scoping now) ---

    async loadHistory(_chatId, limit = 20) {
      void _chatId;
      return loadHistoryRows(limit);
    },

    async saveMessage(chatId, role, text) {
      const { error } = await supabase.from("telegram_messages").insert({
        company_id: company,
        chat_id: chatId,
        channel,
        role,
        text,
      });
      if (error) throw new Error(error.message);
    },

    async loadMemories() {
      const { data, error } = await supabase
        .from("bot_memories")
        .select("kind, content, created_at")
        .eq("company_id", company)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw new Error(error.message);
      return (data ?? []) as BotMemoryRow[];
    },

    async saveMemory(kind, content, options?: { supersedesId?: string; provenance?: string }) {
      const { data, error } = await supabase
        .from("bot_memories")
        .insert({
          company_id: company,
          kind,
          content,
          source: channel,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      const newId = (data as { id?: string } | null)?.id ?? null;
      if (newId) {
        // Lane 2: embed at write time (best-effort - the night shift
        // backfills anything missed) and close whatever this fact
        // supersedes (same-subject profiles/business facts, plus an
        // explicitly named row). Both steps are individually
        // graceful before migration 00029 lands.
        const provider = getEmbeddingProvider();
        const vector = await tryEmbed(provider, content);
        if (vector && provider) {
          const { error: embedError } = await supabase
            .from("bot_memories")
            .update({ embedding: toVectorLiteral(vector), embedding_model: provider.model })
            .eq("id", newId)
            .eq("company_id", company);
          if (embedError && !isMissingColumnError(embedError)) {
            console.error("[bot-store] memory embedding write failed", embedError.message);
          }
        }
        if (options?.provenance) {
          const { error: provError } = await supabase
            .from("bot_memories")
            .update({ provenance: options.provenance })
            .eq("id", newId)
            .eq("company_id", company);
          if (provError && !isMissingColumnError(provError)) {
            console.error("[bot-store] memory provenance write failed", provError.message);
          }
        }
        await applySupersession(supabase, company, { id: newId, kind, content }, {
          supersedesId: options?.supersedesId,
          // CD-4: a same-name person profile whose role doesn't
          // confirm the same person was deliberately NOT closed.
          // Stage the question on the existing proposal path
          // instead: approving it re-runs save_memory naming the
          // old row, which closes it through the explicit path.
          onAmbiguousPersonMatch: async (oldRow) => {
            const { error: stageError } = await supabase.from("bot_pending_actions").insert({
              company_id: company,
              channel,
              tool_name: "save_memory",
              arguments: { kind, content, supersedes_id: oldRow.id },
              summary:
                `Replace an older profile? A new profile was just saved ("${content}"), and an older ` +
                `profile with the same name exists ("${oldRow.content}") - but the roles don't confirm ` +
                `they're the same person, so the older one was left current. Yes closes the older ` +
                `profile in favor of the new one; no keeps both.`,
            });
            if (stageError) throw new Error(stageError.message);
          },
        });
      }
      return newId;
    },

    async loadSnapshot() {
      const sinceIso = new Date(Date.now() - SEVEN_DAYS_MS).toISOString().slice(0, 10);
      const [loads, expenses, fuel, brokers, customers, drivers] = await Promise.all([
        supabase
          .from("loads")
          .select("origin, destination, status, pickup_date, delivery_date, rate_cents")
          .eq("company_id", company)
          .is("deleted_at", null)
          .in("status", ["draft", "confirmed"])
          .order("created_at", { ascending: false })
          .limit(5),
        supabase
          .from("expenses")
          .select("amount_cents")
          .eq("company_id", company)
          .is("deleted_at", null)
          .gte("expense_date", sinceIso),
        supabase
          .from("fuel_purchases")
          .select("total_cost_cents")
          .eq("company_id", company)
          .is("deleted_at", null)
          .gte("purchased_at", new Date(Date.now() - SEVEN_DAYS_MS).toISOString()),
        contacts("brokers"),
        contacts("customers"),
        contacts("drivers"),
      ]);

      for (const result of [loads, expenses, fuel]) {
        if (result.error) throw new Error(result.error.message);
      }

      // King review D-1: the same full-window read + carrier-cycle
      // engine as the Hours page; a failed read is stated, not guessed.
      let hos: CompanySnapshot["hos"] = null;
      let hosCycleLine: string | null = null;
      let currentDutyStatus: string | null = null;
      let hosUnavailable = false;
      try {
        const window = await loadHosWindow(supabase, company);
        if (window.rows.length > 0) {
          hos = window.short;
          hosCycleLine = cycleLine(window);
          currentDutyStatus = window.rows[window.rows.length - 1]!.duty_status;
        }
      } catch {
        hosUnavailable = true;
      }

      const sum = (rows: Record<string, unknown>[], field: string) =>
        rows.reduce((total, row) => total + (typeof row[field] === "number" ? (row[field] as number) : 0), 0);

      return {
        activeLoads: (loads.data ?? []) as CompanySnapshot["activeLoads"],
        currentDutyStatus,
        hos,
        hosCycleLine,
        hosUnavailable,
        expensesLast7DaysCents: sum((expenses.data ?? []) as Record<string, unknown>[], "amount_cents"),
        fuelLast7DaysCents: sum((fuel.data ?? []) as Record<string, unknown>[], "total_cost_cents"),
        contacts: { brokers, customers, drivers },
      };
    },

    async storeExchange(incoming, suggestion) {
      // §11: the suggestion now carries ONE reply draft in the other
      // side's language - it lands in the column matching its
      // language (both columns nullable); the translation column
      // stays null for English messages, which is exactly the point.
      const { error } = await supabase.from("dispatch_exchanges").insert({
        company_id: company,
        incoming_message: incoming,
        ai_translation: suggestion.translation_en,
        ai_suggested_reply_en:
          suggestion.suggested_reply_language === "en" ? suggestion.suggested_reply : null,
        ai_suggested_reply_es:
          suggestion.suggested_reply_language === "es" ? suggestion.suggested_reply : null,
        actual_reply_sent: null, // the bot can't see what he sends elsewhere (design §5)
        source: channel,
      });
      if (error) throw new Error(error.message);
    },

    // --- v2 shared-brain surface ---

    async loadConversationHistory(limit = 20) {
      return loadHistoryRows(limit);
    },

    async saveConversationMessage(role, text) {
      const { error } = await supabase.from("telegram_messages").insert({
        company_id: company,
        chat_id: null,
        channel,
        role,
        text,
      });
      if (error) throw new Error(error.message);
    },

    async loadPendingAction() {
      return (await targetGroup())?.[0] ?? null;
    },

    async loadPendingBatch() {
      const group = await targetGroup();
      const first = group?.[0];
      if (!first || !first.batch_id) return [];
      return group!;
    },

    async dropExpiredPending(cutoffIso, keepKey) {
      const rows = (await loadPendingRows()).filter(
        (r) => r.tool_name !== "photo_purpose" && r.created_at < cutoffIso && (r.batch_id ?? r.id) !== keepKey,
      );
      if (rows.length === 0) return 0;
      await this.clearPendingActions(rows.map((r) => r.id));
      return rows.length;
    },

    async loadOpenPendingGroups() {
      return groupPending(await loadPendingRows()).map((g) => ({
        key: g[0]!.batch_id ?? g[0]!.id,
        toolName: g[0]!.tool_name,
        summary: g.length > 1 ? `${g.length} items: ${g.map((r) => r.summary).join("; ")}` : g[0]!.summary,
        createdAt: newestCreatedAt(g),
      }));
    },

    async savePendingAction(action) {
      const base = {
        company_id: company,
        channel,
        tool_name: action.toolName,
        arguments: action.args,
        summary: action.summary,
      };
      if (action.batchId === undefined) {
        const { error } = await supabase.from("bot_pending_actions").insert(base);
        if (error) throw new Error(error.message);
        return;
      }
      const withBatch = {
        ...base,
        batch_id: action.batchId,
        item_number: action.itemNumber ?? null,
        source_quote: action.sourceQuote ?? null,
        confidence: action.confidence ?? null,
      };
      const { error } = await supabase.from("bot_pending_actions").insert(withBatch);
      if (error) {
        // Graceful absence (design §9): before migration 00021 the
        // batch columns don't exist - store the proposal as a plain
        // §8 row rather than losing it.
        if (!isMissingColumnError(error)) throw new Error(error.message);
        const { error: fallbackError } = await supabase.from("bot_pending_actions").insert(base);
        if (fallbackError) throw new Error(fallbackError.message);
      }
    },

    async updatePendingAction(id, args, summary) {
      const { error } = await supabase
        .from("bot_pending_actions")
        .update({ arguments: args, summary })
        .eq("id", id)
        .eq("company_id", company)
        .is("deleted_at", null);
      if (error) throw new Error(error.message);
    },

    async clearPendingAction(id) {
      const { error } = await supabase
        .from("bot_pending_actions")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .eq("company_id", company)
        .is("deleted_at", null);
      if (error) throw new Error(error.message);
    },

    async clearPendingActions(ids) {
      if (ids.length === 0) return;
      const { error } = await supabase
        .from("bot_pending_actions")
        .update({ deleted_at: new Date().toISOString() })
        .in("id", ids)
        .eq("company_id", company)
        .is("deleted_at", null);
      if (error) throw new Error(error.message);
    },

    async isBotChatEnabled() {
      return capabilityEnabled(BOT_CHAT_CAPABILITY);
    },

    async isDispatchHelperEnabled() {
      return capabilityEnabled(DISPATCH_HELPER_CAPABILITY);
    },

    async claimTelegramUpdate(updateId: number) {
      const { error } = await supabase.from("telegram_processed_updates").insert({
        company_id: company,
        update_id: updateId,
      });
      if (!error) {
        await pruneProcessedUpdates();
        return true;
      }
      // Unique violation = this update was already claimed: a
      // Telegram redelivery, which must never be processed twice.
      if ((error as { code?: string }).code === "23505") return false;
      // Graceful absence: migration 00033 not applied yet - dedup is
      // inactive and the turn proceeds as it historically did.
      if (/telegram_processed_updates/.test(error.message) && /does not exist|could not find/i.test(error.message)) {
        return true;
      }
      throw new Error(error.message);
    },

    async releaseTelegramUpdate(updateId: number) {
      const { error } = await supabase
        .from("telegram_processed_updates")
        .delete()
        .eq("company_id", company)
        .eq("update_id", updateId);
      if (!error) return;
      // Graceful absence: migration 00033 not applied yet - there
      // was no claim to release.
      if (/telegram_processed_updates/.test(error.message) && /does not exist|could not find/i.test(error.message)) {
        return;
      }
      throw new Error(error.message);
    },

    // --- Lane 2 (Phases A+B): see store-memory.ts ---
    ...createMemoryStore(supabase, company, capabilityEnabled),

    // --- Phase D (pay truth): see store-pay.ts ---
    ...createPayStore(supabase, company),

    // --- Phase C (threads + people): see store-threads.ts ---
    ...createThreadStore(supabase, company),

    // --- Phase E (voice + twin) ---

    async isVoiceTranscriptionEnabled() {
      return capabilityEnabled(VOICE_TRANSCRIPTION_CAPABILITY);
    },

    async isDriverTwinEnabled() {
      return capabilityEnabled(DRIVER_TWIN_CAPABILITY);
    },

    async loadVoiceExemplars(incomingText: string) {
      const { data, error } = await supabase
        .from("dispatch_exchanges")
        .select("id, incoming_message, actual_reply_sent")
        .eq("company_id", company)
        .is("deleted_at", null)
        .not("actual_reply_sent", "is", null)
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) throw new Error(error.message);
      const candidates = ((data ?? []) as { id: string; incoming_message: string; actual_reply_sent: string | null }[]).map(
        (row) => ({ id: row.id, incoming: row.incoming_message, actualReply: row.actual_reply_sent }),
      );
      return rankExemplars(incomingText, candidates, 3);
    },

    async recordSentReply(exchangeId: string, actualReply: string) {
      const { data, error } = await supabase
        .from("dispatch_exchanges")
        .select("id, ai_suggested_reply_en, ai_suggested_reply_es")
        .eq("id", exchangeId)
        .eq("company_id", company)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const row = data as { ai_suggested_reply_en: string | null; ai_suggested_reply_es: string | null } | null;
      if (!row) throw new Error(`No dispatch exchange with id ${exchangeId} in his records.`);
      const draft = row.ai_suggested_reply_es ?? row.ai_suggested_reply_en ?? null;
      const ratio = draft ? editDistanceRatio(draft, actualReply) : null;
      const { error: updateError } = await supabase
        .from("dispatch_exchanges")
        .update({
          actual_reply_sent: actualReply,
          edit_distance_ratio: ratio,
          reply_captured_at: new Date().toISOString(),
        })
        .eq("id", exchangeId)
        .eq("company_id", company);
      if (updateError) {
        if (/edit_distance_ratio|reply_captured_at/.test(updateError.message)) {
          throw new Error(
            "Sent-reply capture isn't available yet - migration 00050 hasn't been applied to the database, so the edit-distance columns don't exist. The reply itself wasn't recorded.",
          );
        }
        throw new Error(updateError.message);
      }
      return { editDistanceRatio: ratio };
    },

    async listRecentExchanges(limit = 10) {
      const { data, error } = await supabase
        .from("dispatch_exchanges")
        .select("id, incoming_message, ai_suggested_reply_en, ai_suggested_reply_es, actual_reply_sent, edit_distance_ratio, created_at")
        .eq("company_id", company)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) {
        // Before 00050 the edit_distance column doesn't exist - fall
        // back to the pre-E column set rather than failing the read.
        if (/edit_distance_ratio/.test(error.message)) {
          const fallback = await supabase
            .from("dispatch_exchanges")
            .select("id, incoming_message, ai_suggested_reply_en, ai_suggested_reply_es, actual_reply_sent, created_at")
            .eq("company_id", company)
            .is("deleted_at", null)
            .order("created_at", { ascending: false })
            .limit(limit);
          if (fallback.error) throw new Error(fallback.error.message);
          return ((fallback.data ?? []) as Record<string, unknown>[]).map((row) => ({
            id: String(row.id),
            incoming: String(row.incoming_message),
            hasDraft: Boolean(row.ai_suggested_reply_en ?? row.ai_suggested_reply_es),
            actualReplySent: (row.actual_reply_sent as string | null) ?? null,
            editDistanceRatio: null,
            createdAt: String(row.created_at),
          }));
        }
        throw new Error(error.message);
      }
      return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        id: String(row.id),
        incoming: String(row.incoming_message),
        hasDraft: Boolean(row.ai_suggested_reply_en ?? row.ai_suggested_reply_es),
        actualReplySent: (row.actual_reply_sent as string | null) ?? null,
        editDistanceRatio: typeof row.edit_distance_ratio === "number" ? row.edit_distance_ratio : null,
        createdAt: String(row.created_at),
      }));
    },

    async recordLoadDecision(input) {
      const { error } = await supabase.from("load_decisions").insert({
        company_id: company,
        load_id: input.loadId ?? null,
        description: input.description,
        decision: input.decision,
        outcome_note: input.outcomeNote ?? null,
      });
      if (error) {
        if (/load_decisions/.test(error.message) && /does not exist|could not find/i.test(error.message)) {
          throw new Error(
            "The decision log isn't available yet - migration 00050 hasn't been applied to the database. Nothing was logged.",
          );
        }
        throw new Error(error.message);
      }
    },

    async listLoadDecisions(limit = 100) {
      const { data, error } = await supabase
        .from("load_decisions")
        .select("id, load_id, description, decision, outcome_note, created_at")
        .eq("company_id", company)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) {
        if (/load_decisions/.test(error.message) && /does not exist|could not find/i.test(error.message)) {
          return [];
        }
        throw new Error(error.message);
      }
      return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        id: String(row.id),
        loadId: (row.load_id as string | null) ?? null,
        description: String(row.description),
        decision: String(row.decision),
        outcomeNote: (row.outcome_note as string | null) ?? null,
        createdAt: String(row.created_at),
      }));
    },

    async twinEditStats(fromIso: string, toIso: string) {
      const { data, error } = await supabase
        .from("dispatch_exchanges")
        .select("edit_distance_ratio")
        .eq("company_id", company)
        .is("deleted_at", null)
        .not("reply_captured_at", "is", null)
        .gte("reply_captured_at", fromIso)
        .lte("reply_captured_at", toIso)
        .limit(500);
      if (error) {
        if (/edit_distance_ratio|reply_captured_at/.test(error.message)) return { count: 0, avgDistance: null };
        throw new Error(error.message);
      }
      const ratios = ((data ?? []) as { edit_distance_ratio: number | null }[])
        .map((r) => r.edit_distance_ratio)
        .filter((r): r is number => typeof r === "number");
      return {
        count: ratios.length,
        avgDistance: ratios.length > 0 ? ratios.reduce((t, r) => t + r, 0) / ratios.length : null,
      };
    },
  };

  /**
   * CD-9: delete this company's dedup claims older than the
   * retention window (keyed on processed_at, the claim timestamp
   * migration 00033 stamps at insert). Throttled per process and
   * failure-tolerant by design: pruning must never fail a claim -
   * a failure logs and the next claim after the interval retries.
   */
  async function pruneProcessedUpdates(): Promise<void> {
    const now = Date.now();
    if (now - lastProcessedUpdatePruneAt < PROCESSED_UPDATE_PRUNE_INTERVAL_MS) return;
    lastProcessedUpdatePruneAt = now;
    try {
      const cutoff = new Date(now - PROCESSED_UPDATE_RETENTION_MS).toISOString();
      const { error } = await supabase
        .from("telegram_processed_updates")
        .delete()
        .eq("company_id", company)
        .lt("processed_at", cutoff);
      if (
        error &&
        !(/telegram_processed_updates/.test(error.message) && /does not exist|could not find/i.test(error.message))
      ) {
        console.error("[bot-store] processed-update prune failed", error.message);
      }
    } catch (err) {
      console.error("[bot-store] processed-update prune failed", err);
    }
  }

  /** One capability check, shared by every kill switch: global switch first, then the per-capability row; no row = off (fails closed). */
  async function capabilityEnabled(capability: string): Promise<boolean> {
    const [companyResult, capabilityResult] = await Promise.all([
      supabase.from("companies").select("ai_globally_disabled").eq("id", company).single(),
      supabase
        .from("ai_capability_settings")
        .select("enabled")
        .eq("company_id", company)
        .eq("capability", capability)
        .maybeSingle(),
    ]);
    if (companyResult.error) throw new Error(companyResult.error.message);
    if (capabilityResult.error) throw new Error(capabilityResult.error.message);

    const globallyDisabled =
      (companyResult.data as { ai_globally_disabled: boolean } | null)?.ai_globally_disabled ?? false;
    // No row = off, fails closed - same convention as every other capability.
    const enabled =
      (capabilityResult.data as { enabled: boolean } | null)?.enabled ?? false;
    return !globallyDisabled && enabled;
  }
}
