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
import type { FactRetrieval, RetrievedFact } from "@/services/bot/memory-retrieval";
import type { BotMemoryRow, CompanySnapshot } from "./context";

export interface TelegramStore {
  loadHistory(chatId: number, limit?: number): Promise<BotChatTurn[]>;
  saveMessage(chatId: number, role: "user" | "assistant", text: string): Promise<void>;
  loadMemories(): Promise<BotMemoryRow[]>;
  // Return widened to unknown (Lane 2): the brain store's save
  // resolves the new row's id for lifecycle bookkeeping; v1 callers
  // just await it and ignore the value, as they always have.
  saveMemory(kind: BotMemoryRow["kind"], content: string): Promise<unknown>;
  loadSnapshot(): Promise<CompanySnapshot | null>;
  storeExchange(incoming: string, suggestion: DispatchSuggestion): Promise<void>;
  /** Lane 1 (audit B-2): update_id claim for webhook dedup - see BotBrainStore. Optional on this v1 surface; the brain store implements it. */
  claimTelegramUpdate?(updateId: number): Promise<boolean>;
  /** Fix round (pitfall hunt CD-6): releases a claim whose turn never completed, so Telegram's redelivery can reprocess - see BotBrainStore. Optional on this v1 surface; the brain store implements it. */
  releaseTelegramUpdate?(updateId: number): Promise<void>;
  /** Lane 2 (Phase A): hybrid retrieval over ALL current facts - see BotBrainStore. Optional here; dispatch-bot falls back to loadMemories + keyword pick when absent. */
  retrieveFacts?(query: string): Promise<FactRetrieval>;
  /** Lane 2 (Phase A): ALL standing instructions on their own query. Optional here, same fallback story as retrieveFacts. */
  loadInstructionMemories?(): Promise<RetrievedFact[]>;
  /** Phase D: the current pay pin (from the brain store). Optional here; dispatch-bot skips the pin block when absent. */
  loadPayPin?(): Promise<import("@/services/bot/pay-pin").PayPin>;
  /** Phase C: the owner's "Life phase" override text (from the brain store). Optional, same pattern. */
  loadLifePhaseOverride?(): Promise<string | null>;
  /** Phase C: thread reads for the open-loops context block (from the brain store). Optional, same pattern. */
  listThreads?(options?: { openOnly?: boolean; unansweredOnly?: boolean; limit?: number }): Promise<import("@/services/bot/store").StoredThread[]>;
  /** Phase E: the driver_twin kill switch (from the brain store). Optional; absent = twin off on this surface. */
  isDriverTwinEnabled?(): Promise<boolean>;
  /** Phase E: draft-time voice exemplars (from the brain store). Optional, same pattern. */
  loadVoiceExemplars?(incomingText: string): Promise<import("@/services/bot/voice-corpus").VoiceExemplar[]>;
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
