// Driver MVP bot intelligence (docs/design/driver-mvp.md §6). The
// Telegram bot's data access. The webhook has no user session, so -
// like exchange capture (design §5) - this uses the server-only
// service-role key scoped to the single company id from
// TELEGRAM_COMPANY_ID. Every query is additionally filtered by that
// company id in code. If the env isn't configured, createTelegramStore
// returns null and the bot runs in its reduced mode (dispatch replies
// only, no history/snapshot/memory) rather than failing.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { summarizeHos } from "@/lib/hos";
import type { DispatchSuggestion } from "@/services/ai/dispatch";
import type { BotChatTurn } from "@/services/ai/bot-chat";
import type { BotMemoryRow, CompanySnapshot } from "./context";
import type { DutyLog } from "@/types/entities";

export interface TelegramStore {
  loadHistory(chatId: number, limit?: number): Promise<BotChatTurn[]>;
  saveMessage(chatId: number, role: "user" | "assistant", text: string): Promise<void>;
  loadMemories(): Promise<BotMemoryRow[]>;
  saveMemory(kind: BotMemoryRow["kind"], content: string): Promise<void>;
  loadSnapshot(): Promise<CompanySnapshot | null>;
  storeExchange(incoming: string, suggestion: DispatchSuggestion): Promise<void>;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function createTelegramStore(companyId: string | null): TelegramStore | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!companyId || !url || !serviceRoleKey) return null;

  const supabase: SupabaseClient = createClient(url, serviceRoleKey);
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

  return {
    async loadHistory(chatId, limit = 20) {
      const { data, error } = await supabase
        .from("telegram_messages")
        .select("role, text")
        .eq("company_id", company)
        .eq("chat_id", chatId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return ((data ?? []) as BotChatTurn[]).reverse();
    },

    async saveMessage(chatId, role, text) {
      const { error } = await supabase.from("telegram_messages").insert({
        company_id: company,
        chat_id: chatId,
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
        source: "telegram",
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
        source: "telegram",
      });
      if (error) throw new Error(error.message);
    },
  };
}
