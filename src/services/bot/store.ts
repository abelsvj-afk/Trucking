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
import { isMissingColumnError } from "./tool-helpers";
import { MEMORY_CONSOLIDATION_CAPABILITY } from "./consolidation";
import { PHOTO_INTELLIGENCE_CAPABILITY } from "@/services/ai/photo-classification";
import { MAINTENANCE_WATCH_CAPABILITY } from "@/services/fleet/maintenance-watch";
import { getEmbeddingProvider, toVectorLiteral, tryEmbed } from "./embeddings";
import { applySupersession } from "./memory-lifecycle";
import {
  loadAllInstructions,
  retrieveCurrentFacts,
  type FactRetrieval,
  type RetrievedFact,
} from "./memory-retrieval";
import type { DispatchSuggestion } from "@/services/ai/dispatch";
import type { BotChatTurn } from "@/services/ai/bot-chat";
import type { TelegramStore } from "@/services/telegram/store";
import type { BotMemoryRow, CompanySnapshot } from "@/services/telegram/context";
import type { DutyLog } from "@/types/entities";
import { findPayPin, type PayPin } from "./pay-pin";
import { parseBusinessFact, parsePersonProfile } from "./people";
import { LIFE_PHASE_SUBJECT } from "./life-phase";
import {
  matchThreadForAppend,
  mergeParticipants,
  normalizeName,
  threadLanguageFromMessages,
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
  checkSettlementAgainstPin,
  computeTruePay,
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

/** Phase D: the settlements columns every read selects (migration 00048). */
const SETTLEMENT_COLUMNS =
  "id, issuer_name, period_start, period_end, gross_cents, carrier_cut_cents, net_to_truck_cents, driver_pay_cents, miles_total, miles_loaded, duty_minutes, pin_check, pin_check_detail, created_at";

/** Phase C: the forward_threads columns every read selects (migration 00049). */
const THREAD_COLUMNS =
  "id, title, status, language, the_ask, ask_of, deadline_text, participants, unanswered, updated_at, created_at";

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
   * was most recently shown - never the oldest (Trip 1852 audit, P1).
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

    // --- Lane 2 (Phases A+B) ---

    async retrieveFacts(query: string) {
      return retrieveCurrentFacts(supabase, company, query, {
        embedder: getEmbeddingProvider(),
      });
    },

    async loadInstructionMemories() {
      return loadAllInstructions(supabase, company);
    },

    async loadLatestSummary() {
      const { data, error } = await supabase
        .from("conversation_summaries")
        .select("week_start, summary")
        .eq("company_id", company)
        .is("deleted_at", null)
        .order("week_start", { ascending: false })
        .limit(1);
      if (error) {
        // Graceful absence: migration 00032 not applied yet.
        if (/conversation_summaries/.test(error.message) && /does not exist|could not find/i.test(error.message)) {
          return null;
        }
        throw new Error(error.message);
      }
      const row = (data ?? [])[0] as { week_start: string; summary: string } | undefined;
      return row ? { weekStart: row.week_start, summary: row.summary } : null;
    },

    async isMemoryConsolidationEnabled() {
      return capabilityEnabled(MEMORY_CONSOLIDATION_CAPABILITY);
    },

    async isPhotoIntelligenceEnabled() {
      return capabilityEnabled(PHOTO_INTELLIGENCE_CAPABILITY);
    },

    async isMaintenanceWatchEnabled() {
      return capabilityEnabled(MAINTENANCE_WATCH_CAPABILITY);
    },

    async listMemories(options?: { includeHistory?: boolean; limit?: number }) {
      const run = (withLifecycle: boolean) => {
        let q = supabase
          .from("bot_memories")
          .select(
            withLifecycle
              ? "id, kind, content, created_at, valid_to, superseded_by"
              : "id, kind, content, created_at",
          )
          .eq("company_id", company)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(options?.limit ?? 500);
        if (withLifecycle && !options?.includeHistory) q = q.is("valid_to", null);
        return q;
      };
      let result = await run(true);
      if (result.error && isMissingColumnError(result.error)) result = await run(false);
      if (result.error) throw new Error(result.error.message);
      return ((result.data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({
        id: String(row.id),
        kind: String(row.kind),
        content: String(row.content),
        created_at: String(row.created_at),
        valid_to: typeof row.valid_to === "string" ? row.valid_to : null,
        superseded_by: typeof row.superseded_by === "string" ? row.superseded_by : null,
      })) as (RetrievedFact & { valid_to: string | null; superseded_by: string | null })[];
    },

    async editMemory(id: string, content: string) {
      const { data: existing, error: loadError } = await supabase
        .from("bot_memories")
        .select("id, kind")
        .eq("id", id)
        .eq("company_id", company)
        .is("deleted_at", null)
        .maybeSingle();
      if (loadError) throw new Error(loadError.message);
      if (!existing) throw new Error("That memory doesn't exist (or was already deleted).");
      const kind = (existing as { kind: BotMemoryRow["kind"] }).kind;
      // The correction lands as a NEW row that supersedes the old
      // one - history keeps the original wording and its dates.
      const newId = await this.saveMemory(kind, content, {
        supersedesId: id,
        provenance: "owner_stated",
      });
      if (!newId) throw new Error("The corrected memory couldn't be saved.");
      return newId;
    },

    async deleteMemory(id: string) {
      const { error } = await supabase
        .from("bot_memories")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .eq("company_id", company)
        .is("deleted_at", null);
      if (error) throw new Error(error.message);
    },

    // --- Phase D (pay truth) ---

    async loadPayPin() {
      // Current business_fact rows only: valid_to closes superseded
      // pins (Lane 2 lifecycle). Before migration 00029 lands the
      // lifecycle columns don't exist - fall back to newest-first,
      // where findPayPin takes the first (newest) pin line.
      const run = (withLifecycle: boolean) => {
        let q = supabase
          .from("bot_memories")
          .select("content")
          .eq("company_id", company)
          .eq("kind", "business_fact")
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(100);
        if (withLifecycle) q = q.is("valid_to", null);
        return q;
      };
      let result = await run(true);
      if (result.error && isMissingColumnError(result.error)) result = await run(false);
      if (result.error) throw new Error(result.error.message);
      return findPayPin((result.data ?? []) as { content: string }[]);
    },

    async recordSettlement(input: SettlementRecordInput) {
      const dutyMinutes =
        input.dutyMinutes ??
        (await dutyMinutesInRange(input.periodStart, input.periodEnd));
      const figures: SettlementFigures = { ...input, dutyMinutes };
      const pin = await this.loadPayPin();
      const linkedLoadIds = [
        ...new Set(input.lines.map((l) => l.loadId).filter((id): id is string => Boolean(id))),
      ];
      const check = checkSettlementAgainstPin(figures, pin, linkedLoadIds.length);
      const truePay = computeTruePay(figures, pin);

      const { data, error } = await supabase
        .from("settlements")
        .insert({
          company_id: company,
          issuer_name: input.issuerName,
          period_start: input.periodStart,
          period_end: input.periodEnd,
          gross_cents: input.grossCents,
          carrier_cut_cents: input.carrierCutCents,
          net_to_truck_cents: input.netToTruckCents,
          driver_pay_cents: input.driverPayCents,
          miles_total: input.milesTotal,
          miles_loaded: input.milesLoaded,
          duty_minutes: dutyMinutes,
          source_document_id: input.sourceDocumentId ?? null,
          pin_check: check.status,
          pin_check_detail: check.detail,
          tax_setaside_cents: truePay.taxSetasideCents,
          spendable_cents: truePay.spendableCents,
          effective_cpm_cents: truePay.effectiveCpmCents,
          effective_hourly_cents: truePay.effectiveHourlyCents,
          other_model_pay_cents: truePay.otherModelPayCents,
          notes: input.notes ?? null,
        })
        .select("id")
        .single();
      if (error) {
        if (/settlements/.test(error.message) && /does not exist|could not find/i.test(error.message)) {
          throw new Error(
            "Settlements aren't available yet - migration 00048 hasn't been applied to the database, so nothing was recorded.",
          );
        }
        throw new Error(error.message);
      }
      const settlementId = (data as { id: string }).id;

      if (input.lines.length > 0) {
        const { error: linesError } = await supabase.from("settlement_lines").insert(
          input.lines.map((line) => ({
            company_id: company,
            settlement_id: settlementId,
            kind: line.kind,
            label: line.label,
            amount_cents: line.amountCents,
            load_id: line.loadId ?? null,
          })),
        );
        if (linesError) throw new Error(linesError.message);
      }
      if (linkedLoadIds.length > 0) {
        const { error: linksError } = await supabase.from("settlement_load_links").insert(
          linkedLoadIds.map((loadId) => ({
            company_id: company,
            settlement_id: settlementId,
            load_id: loadId,
            matched_by: "line",
          })),
        );
        if (linksError) throw new Error(linksError.message);
      }

      return {
        id: settlementId,
        pinCheck: check.status,
        pinCheckDetail: check.detail,
        truePayLines: truePay.lines,
      };
    },

    async listSettlements(limit = 10) {
      const { data, error } = await supabase
        .from("settlements")
        .select(SETTLEMENT_COLUMNS)
        .eq("company_id", company)
        .is("deleted_at", null)
        .order("period_end", { ascending: false })
        .limit(limit);
      if (error) return settlementsOrThrow(error);
      return mapSettlementRows(data);
    },

    async listSettlementsInRange(startDate: string, endDate: string) {
      const { data, error } = await supabase
        .from("settlements")
        .select(SETTLEMENT_COLUMNS)
        .eq("company_id", company)
        .is("deleted_at", null)
        .lte("period_start", endDate)
        .gte("period_end", startDate)
        .order("period_end", { ascending: false })
        .limit(50);
      if (error) return settlementsOrThrow(error);
      return mapSettlementRows(data);
    },

    async listCompletedLoadsInRange(startDate: string, endDate: string) {
      const { data, error } = await supabase
        .from("loads")
        .select("origin, destination, rate_cents, miles")
        .eq("company_id", company)
        .eq("status", "completed")
        .is("deleted_at", null)
        .gte("delivery_date", startDate)
        .lte("delivery_date", endDate)
        .limit(100);
      if (error) throw new Error(error.message);
      return ((data ?? []) as { origin: string; destination: string; rate_cents: number | null; miles: number | null }[]).map(
        (row) => ({
          origin: row.origin,
          destination: row.destination,
          rateCents: row.rate_cents,
          miles: row.miles,
        }),
      );
    },

    async payReportRunForWeek(weekStart: string) {
      const { data, error } = await supabase
        .from("pay_report_runs")
        .select("week_start, sent, figures, created_at")
        .eq("company_id", company)
        .eq("week_start", weekStart)
        .is("deleted_at", null)
        .limit(1);
      if (error) {
        // Graceful absence: migration 00048 not applied yet - the
        // report job simply has no state and stays quiet.
        if (/pay_report_runs/.test(error.message) && /does not exist|could not find/i.test(error.message)) {
          return null;
        }
        throw new Error(error.message);
      }
      const row = (data ?? [])[0] as
        | { week_start: string; sent: boolean; figures: { closedEmpty?: unknown } | null; created_at: string }
        | undefined;
      return row
        ? {
            weekStart: row.week_start,
            sent: row.sent,
            closedEmpty: row.figures?.closedEmpty === true,
            createdAt: row.created_at,
          }
        : null;
    },

    async recordPayReportRun(weekStart: string, sent: boolean, figures: Record<string, unknown>) {
      // Upsert on the week's unique key: a retry after a failed send
      // updates the same marker instead of piling up run rows.
      const { error } = await supabase.from("pay_report_runs").upsert(
        {
          company_id: company,
          week_start: weekStart,
          sent,
          figures,
          deleted_at: null,
        },
        { onConflict: "company_id,week_start" },
      );
      if (error) throw new Error(error.message);
    },

    // --- Phase C (threads + people) ---

    async recordForwardThread(input: ThreadRecordInput) {
      const missing = (message: string) => /forward_thread/.test(message) && /does not exist|could not find/i.test(message);
      // Append matching is CODE (threads.ts): an open thread sharing
      // a counterparty takes the segment; otherwise a new thread.
      const { data: openRows, error: openError } = await supabase
        .from("forward_threads")
        .select("id, participants, language, updated_at")
        .eq("company_id", company)
        .eq("status", "open")
        .is("deleted_at", null)
        .order("updated_at", { ascending: false })
        .limit(50);
      if (openError) {
        if (missing(openError.message)) {
          throw new Error(
            "Thread recording isn't available yet - migration 00049 hasn't been applied to the database. The conversation itself is still in his timeline and dispatch history; only the thread record is missing.",
          );
        }
        throw new Error(openError.message);
      }
      const candidates = ((openRows ?? []) as { id: string; participants: unknown; updated_at: string }[]).map((row) => ({
        id: row.id,
        participants: threadParticipantsOf(row.participants),
        updatedAt: row.updated_at,
      }));
      const matchedId = matchThreadForAppend(candidates, input.participants);
      const language = threadLanguageFromMessages(input.messages);
      const roleByName = new Map(
        mergeParticipants([], input.participants).map((p) => [normalizeName(p.name), p.role]),
      );
      const messageRows = (threadId: string) =>
        input.messages.map((m) => ({
          company_id: company,
          thread_id: threadId,
          sender_name: m.senderName,
          sender_role: roleByName.get(normalizeName(m.senderName)) ?? null,
          body: m.body,
          language: m.language,
          sent_at: m.sentAt ?? null,
        }));

      if (matchedId) {
        const existing = candidates.find((c) => c.id === matchedId)!;
        const { error: msgError } = await supabase.from("forward_thread_messages").insert(messageRows(matchedId));
        if (msgError) throw new Error(msgError.message);
        const { error: updError } = await supabase
          .from("forward_threads")
          .update({
            participants: mergeParticipants(existing.participants, input.participants),
            the_ask: input.theAsk ?? undefined,
            ask_of: input.askOf ?? undefined,
            deadline_text: input.deadlineText ?? undefined,
            unanswered: input.unanswered,
            language: language ?? undefined,
            last_exchange_id: input.exchangeId ?? undefined,
            updated_at: new Date().toISOString(),
          })
          .eq("id", matchedId)
          .eq("company_id", company);
        if (updError) throw new Error(updError.message);
        return { threadId: matchedId, appended: true, messageCount: input.messages.length };
      }

      const { data: created, error: createError } = await supabase
        .from("forward_threads")
        .insert({
          company_id: company,
          title: input.title ?? null,
          status: "open",
          language,
          the_ask: input.theAsk ?? null,
          ask_of: input.askOf ?? null,
          deadline_text: input.deadlineText ?? null,
          participants: input.participants,
          unanswered: input.unanswered,
          last_exchange_id: input.exchangeId ?? null,
          source: input.source,
        })
        .select("id")
        .single();
      if (createError) throw new Error(createError.message);
      const threadId = (created as { id: string }).id;
      const { error: msgError } = await supabase.from("forward_thread_messages").insert(messageRows(threadId));
      if (msgError) throw new Error(msgError.message);
      return { threadId, appended: false, messageCount: input.messages.length };
    },

    async listThreads(options?: { openOnly?: boolean; unansweredOnly?: boolean; limit?: number }) {
      let query = supabase
        .from("forward_threads")
        .select(THREAD_COLUMNS)
        .eq("company_id", company)
        .is("deleted_at", null)
        .order("updated_at", { ascending: false })
        .limit(options?.limit ?? 20);
      if (options?.openOnly) query = query.eq("status", "open");
      if (options?.unansweredOnly) query = query.eq("unanswered", true);
      const { data, error } = await query;
      if (error) return threadsOrThrow(error);
      return mapThreadRows(data);
    },

    async getThread(threadId: string) {
      const { data, error } = await supabase
        .from("forward_threads")
        .select(THREAD_COLUMNS)
        .eq("id", threadId)
        .eq("company_id", company)
        .is("deleted_at", null)
        .limit(1);
      if (error) {
        if (/forward_thread/.test(error.message) && /does not exist|could not find/i.test(error.message)) return null;
        throw new Error(error.message);
      }
      const thread = mapThreadRows(data)[0];
      if (!thread) return null;
      const { data: msgData, error: msgError } = await supabase
        .from("forward_thread_messages")
        .select("id, sender_name, sender_role, body, language, sent_at, created_at")
        .eq("company_id", company)
        .eq("thread_id", threadId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .limit(500);
      if (msgError) throw new Error(msgError.message);
      const messages = ((msgData ?? []) as Record<string, unknown>[]).map((row) => ({
        id: String(row.id),
        senderName: String(row.sender_name),
        senderRole: (row.sender_role as string | null) ?? null,
        body: String(row.body),
        language: (row.language as string | null) ?? null,
        sentAt: (row.sent_at as string | null) ?? null,
        createdAt: String(row.created_at),
      }));
      return { thread, messages };
    },

    async markThreadAnswered(threadId: string) {
      const { error } = await supabase
        .from("forward_threads")
        .update({ unanswered: false, updated_at: new Date().toISOString() })
        .eq("id", threadId)
        .eq("company_id", company);
      if (error) throw new Error(error.message);
    },

    async closeThread(threadId: string) {
      const { error } = await supabase
        .from("forward_threads")
        .update({ status: "closed", unanswered: false, updated_at: new Date().toISOString() })
        .eq("id", threadId)
        .eq("company_id", company);
      if (error) throw new Error(error.message);
    },

    async findExchangeIdByIncoming(incoming: string) {
      const { data, error } = await supabase
        .from("dispatch_exchanges")
        .select("id")
        .eq("company_id", company)
        .eq("incoming_message", incoming)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      const row = (data ?? [])[0] as { id: string } | undefined;
      return row?.id ?? null;
    },

    async loadPersonEvidence(name: string) {
      const key = normalizeName(name);
      // Confirmed profile (his approved words) from current person_profile rows.
      const { data: profileRows } = await supabase
        .from("bot_memories")
        .select("content")
        .eq("company_id", company)
        .eq("kind", "person_profile")
        .is("valid_to", null)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(100);
      const confirmedProfile =
        ((profileRows ?? []) as { content: string }[])
          .map((r) => parsePersonProfile(r.content))
          .find((p) => p !== null && normalizeName(p.name) === key) ?? null;

      // Thread appearances: participant match over recent threads.
      const threads = await this.listThreads({ limit: 100 });
      const appearances: PersonEvidence["threads"] = [];
      const bodies: string[] = [];
      for (const thread of threads) {
        const participant = thread.participants.find((p) => normalizeName(p.name) === key);
        if (!participant) continue;
        const detail = await this.getThread(thread.id);
        const mine = (detail?.messages ?? []).filter((m) => normalizeName(m.senderName) === key);
        appearances.push({
          title: thread.title,
          role: participant.role,
          messagesFromThem: mine.length,
          lastActiveAt: thread.updatedAt,
        });
        for (const m of mine) bodies.push(m.body);
      }

      // Dispatch exchanges naming them (bounded read; a mention count, honestly labeled).
      const { data: exchangeRows } = await supabase
        .from("dispatch_exchanges")
        .select("id")
        .eq("company_id", company)
        .ilike("incoming_message", `%${name}%`)
        .is("deleted_at", null)
        .limit(200);
      return {
        confirmedProfile,
        threads: appearances,
        messageBodies: bodies,
        exchangeMentions: (exchangeRows ?? []).length,
      };
    },

    async loadLifePhaseOverride() {
      const { data, error } = await supabase
        .from("bot_memories")
        .select("content")
        .eq("company_id", company)
        .eq("kind", "business_fact")
        .is("valid_to", null)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) {
        // Pre-00029 the lifecycle columns don't exist - no override
        // can be current; the default phase text stands.
        if (/valid_to/.test(error.message)) return null;
        throw new Error(error.message);
      }
      for (const row of (data ?? []) as { content: string }[]) {
        const parsed = parseBusinessFact(row.content);
        if (parsed && parsed.subject === LIFE_PHASE_SUBJECT) return parsed.fact || null;
      }
      return null;
    },

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

  /** Thread reads degrade gracefully before migration 00049 (empty); writes fail loudly instead - see recordForwardThread. */
  function threadsOrThrow(error: { message: string }): StoredThread[] {
    if (/forward_thread/.test(error.message) && /does not exist|could not find/i.test(error.message)) {
      return [];
    }
    throw new Error(error.message);
  }

  function threadParticipantsOf(value: unknown): ThreadParticipant[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (p): p is ThreadParticipant =>
          typeof p === "object" && p !== null &&
          typeof (p as { name?: unknown }).name === "string" &&
          typeof (p as { role?: unknown }).role === "string",
      )
      .map((p) => ({ name: p.name, role: p.role }));
  }

  function mapThreadRows(data: unknown): StoredThread[] {
    return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      title: (row.title as string | null) ?? null,
      status: String(row.status),
      language: (row.language as string | null) ?? null,
      theAsk: (row.the_ask as string | null) ?? null,
      askOf: (row.ask_of as string | null) ?? null,
      deadlineText: (row.deadline_text as string | null) ?? null,
      participants: threadParticipantsOf(row.participants),
      unanswered: row.unanswered === true,
      updatedAt: String(row.updated_at),
      createdAt: String(row.created_at),
    }));
  }

  /** Settlement reads degrade gracefully before migration 00048 (empty, like every other not-yet-landed read); writes fail loudly instead - see recordSettlement. */
  function settlementsOrThrow(error: { message: string }): StoredSettlement[] {
    if (/settlements/.test(error.message) && /does not exist|could not find/i.test(error.message)) {
      return [];
    }
    throw new Error(error.message);
  }

  function mapSettlementRows(data: unknown): StoredSettlement[] {
    return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      issuerName: String(row.issuer_name),
      periodStart: String(row.period_start),
      periodEnd: String(row.period_end),
      grossCents: Number(row.gross_cents),
      carrierCutCents: typeof row.carrier_cut_cents === "number" ? row.carrier_cut_cents : null,
      netToTruckCents: typeof row.net_to_truck_cents === "number" ? row.net_to_truck_cents : null,
      driverPayCents: Number(row.driver_pay_cents),
      milesTotal: typeof row.miles_total === "number" ? row.miles_total : null,
      milesLoaded: typeof row.miles_loaded === "number" ? row.miles_loaded : null,
      dutyMinutes: typeof row.duty_minutes === "number" ? row.duty_minutes : null,
      pinCheck: String(row.pin_check),
      pinCheckDetail: typeof row.pin_check_detail === "string" ? row.pin_check_detail : null,
      createdAt: String(row.created_at),
    }));
  }

  /**
   * On-duty minutes (driving + on_duty - sleeper and off-duty are
   * not duty time) inside a settlement period, from his paper-log
   * helper rows. Each log runs until the next one starts; the log
   * that began before the period carries in. Dates are read as UTC
   * day boundaries - duty minutes feed an informational $/hour, and
   * the helper was never the legal record (§6 framing stands).
   * Null when he has no logs in or before the period.
   */
  async function dutyMinutesInRange(periodStart: string, periodEnd: string): Promise<number | null> {
    const rangeStart = Date.parse(`${periodStart}T00:00:00.000Z`);
    const rangeEnd = Date.parse(`${periodEnd}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
    const { data, error } = await supabase
      .from("duty_logs")
      .select("started_at, duty_status")
      .eq("company_id", company)
      .is("deleted_at", null)
      .lt("started_at", new Date(rangeEnd).toISOString())
      .order("started_at", { ascending: true })
      .limit(500);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { started_at: string; duty_status: string }[];
    if (rows.length === 0) return null;
    let total = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.duty_status !== "driving" && row.duty_status !== "on_duty") continue;
      const segStart = Math.max(Date.parse(row.started_at), rangeStart);
      const segEnd = Math.min(
        i + 1 < rows.length ? Date.parse(rows[i + 1]!.started_at) : rangeEnd,
        rangeEnd,
      );
      if (segEnd > segStart) total += Math.round((segEnd - segStart) / 60000);
    }
    return total;
  }

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
