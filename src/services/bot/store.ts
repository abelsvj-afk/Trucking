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
}

export interface BotBrainStore extends TelegramStore {
  readonly client: SupabaseClient;
  readonly companyId: string;
  readonly channel: BotChannel;
  /** The shared timeline: recent turns across BOTH channels, oldest first. */
  loadConversationHistory(limit?: number): Promise<BotChatTurn[]>;
  saveConversationMessage(role: "user" | "assistant", text: string): Promise<void>;
  loadPendingAction(): Promise<PendingAction | null>;
  savePendingAction(action: {
    toolName: string;
    args: Record<string, unknown>;
    summary: string;
  }): Promise<void>;
  clearPendingAction(id: string): Promise<void>;
  /** The bot_chat kill switch (docs/governance.md): global switch first, then per-capability, no row = off. */
  isBotChatEnabled(): Promise<boolean>;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

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

    async saveMemory(kind, content) {
      const { error } = await supabase.from("bot_memories").insert({
        company_id: company,
        kind,
        content,
        source: channel,
      });
      if (error) throw new Error(error.message);
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
      const { error } = await supabase.from("dispatch_exchanges").insert({
        company_id: company,
        incoming_message: incoming,
        ai_translation: suggestion.translation_en,
        ai_suggested_reply_en: suggestion.suggested_reply_en,
        ai_suggested_reply_es: suggestion.suggested_reply_es,
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
      const { data, error } = await supabase
        .from("bot_pending_actions")
        .select("id, tool_name, arguments, summary, channel, created_at")
        .eq("company_id", company)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .limit(1);
      if (error) throw new Error(error.message);
      const row = (data ?? [])[0] as PendingAction | undefined;
      return row ?? null;
    },

    async savePendingAction(action) {
      const { error } = await supabase.from("bot_pending_actions").insert({
        company_id: company,
        channel,
        tool_name: action.toolName,
        arguments: action.args,
        summary: action.summary,
      });
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

    async isBotChatEnabled() {
      const [companyResult, capabilityResult] = await Promise.all([
        supabase.from("companies").select("ai_globally_disabled").eq("id", company).single(),
        supabase
          .from("ai_capability_settings")
          .select("enabled")
          .eq("company_id", company)
          .eq("capability", BOT_CHAT_CAPABILITY)
          .maybeSingle(),
      ]);
      if (companyResult.error) throw new Error(companyResult.error.message);
      if (capabilityResult.error) throw new Error(capabilityResult.error.message);

      const globallyDisabled =
        (companyResult.data as { ai_globally_disabled: boolean } | null)?.ai_globally_disabled ?? false;
      // No row = off, fails closed - same convention as every other capability.
      const capabilityEnabled =
        (capabilityResult.data as { enabled: boolean } | null)?.enabled ?? false;
      return !globallyDisabled && capabilityEnabled;
    },
  };
}
