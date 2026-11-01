// Driver MVP bot intelligence (docs/design/driver-mvp.md §6), v2
// restructure (§8). The Telegram bot's data access. The webhook has
// no user session, so - like exchange capture (design §5) - this
// uses the server-only service-role key scoped to the single
// company id from TELEGRAM_COMPANY_ID. Every query is additionally
// filtered by that company id in code. If the env isn't configured,
// the factories return null and the bot runs in its reduced mode
// (dispatch replies only, no history/snapshot/memory) rather than
// failing.
//
// The implementation itself lives in services/bot/store.ts, shared
// with the web chat window: one store, one timeline, one memory -
// this file only builds the Telegram-flavored (service-role,
// channel "telegram") instance of it.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createBotStore, type BotBrainStore } from "@/services/bot/store";
import type { DispatchSuggestion } from "@/services/ai/dispatch";
import type { BotChatTurn } from "@/services/ai/bot-chat";
import type { BotMemoryRow, CompanySnapshot } from "./context";

export interface TelegramStore {
  loadHistory(chatId: number, limit?: number): Promise<BotChatTurn[]>;
  saveMessage(chatId: number, role: "user" | "assistant", text: string): Promise<void>;
  loadMemories(): Promise<BotMemoryRow[]>;
  saveMemory(kind: BotMemoryRow["kind"], content: string): Promise<void>;
  loadSnapshot(): Promise<CompanySnapshot | null>;
  storeExchange(incoming: string, suggestion: DispatchSuggestion): Promise<void>;
}

function serviceRoleClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey);
}

/** The full v2 brain store for the Telegram surface, or null in reduced mode. */
export function createTelegramBrainStore(companyId: string | null): BotBrainStore | null {
  if (!companyId) return null;
  const client = serviceRoleClient();
  if (!client) return null;
  return createBotStore(client, companyId, "telegram");
}

export function createTelegramStore(companyId: string | null): TelegramStore | null {
  return createTelegramBrainStore(companyId);
}
