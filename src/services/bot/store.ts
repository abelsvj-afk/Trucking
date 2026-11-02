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

import type { SupabaseClient } from "@supabase/supabase-js";
import { summarizeHos } from "@/lib/hos";
import { BOT_CHAT_CAPABILITY } from "@/services/ai/agent-loop";
import { DISPATCH_HELPER_CAPABILITY } from "@/services/ai/dispatch";
import { isMissingColumnError } from "./tool-helpers";
import { MEMORY_CONSOLIDATION_CAPABILITY } from "./consolidation";
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
  loadPendingAction(): Promise<PendingAction | null>;
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
  /** "What Abel remembers" surface: current memories, plus superseded history when asked. */
  listMemories(options?: { includeHistory?: boolean; limit?: number }): Promise<(RetrievedFact & { valid_to: string | null; superseded_by: string | null })[]>;
  /** Owner edit = supersede-with-correction (design §3.4: rows are never edited in place). Resolves the NEW row's id. */
  editMemory(id: string, content: string): Promise<string>;
  /** Owner delete = the store's existing soft delete. */
  deleteMemory(id: string): Promise<void>;
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
      const [loads, dutyLogs, expenses, fuel, brokers, customers, drivers] = await Promise.all([
        supabase
          .from("loads")
          .select("origin, destination, status, pickup_date, delivery_date, rate_cents")
          .eq("company_id", company)
          .is("deleted_at", null)
          .in("status", ["draft", "confirmed"])
          .order("created_at", { ascending: false })
          .limit(5),
        supabase
          .from("duty_logs")
          .select("*")
          .eq("company_id", company)
          .is("deleted_at", null)
          .order("started_at", { ascending: false })
          .limit(100),
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

      for (const result of [loads, dutyLogs, expenses, fuel]) {
        if (result.error) throw new Error(result.error.message);
      }

      const dutyRows = (dutyLogs.data ?? []) as DutyLog[];
      const hos = dutyRows.length > 0 ? summarizeHos(dutyRows) : null;
      const currentDutyStatus =
        dutyRows.length > 0
          ? [...dutyRows].sort((a, b) => b.started_at.localeCompare(a.started_at))[0]!.duty_status
          : null;

      const sum = (rows: Record<string, unknown>[], field: string) =>
        rows.reduce((total, row) => total + (typeof row[field] === "number" ? (row[field] as number) : 0), 0);

      return {
        activeLoads: (loads.data ?? []) as CompanySnapshot["activeLoads"],
        currentDutyStatus,
        hos,
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
      const rows = await loadPendingRows();
      return rows[0] ?? null;
    },

    async loadPendingBatch() {
      const rows = await loadPendingRows();
      const first = rows[0];
      if (!first || !first.batch_id) return [];
      return rows
        .filter((row) => row.batch_id === first.batch_id)
        .sort((a, b) => (a.item_number ?? 0) - (b.item_number ?? 0));
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
