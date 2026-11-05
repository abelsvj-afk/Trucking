// The threads + people slice of the bot store (Abel Intelligence Upgrade,
// Phase C): reconstructed forward threads, the person evidence behind the
// per-person model, and the owner/employer/life-phase reads that prompts use.
// Split out of store.ts (decomposition pass, behavior-preserving).

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingColumnError } from "./tool-helpers";
import { parseBusinessFact, parsePersonProfile } from "./people";
import { LIFE_PHASE_SUBJECT } from "./life-phase";
import { matchThreadForAppend, mergeParticipants, normalizeName, threadLanguageFromMessages, type PersonEvidence, type ThreadParticipant } from "./threads";
import type { BotBrainStore, StoredThread, ThreadRecordInput } from "./store";

/** Phase C: the forward_threads columns every read selects (migration 00049). */
const THREAD_COLUMNS =
  "id, title, status, language, the_ask, ask_of, deadline_text, participants, unanswered, updated_at, created_at";

export type ThreadStoreMethods = Pick<BotBrainStore, "recordForwardThread" | "listThreads" | "getThread" | "markThreadAnswered" | "closeThread" | "findExchangeIdByIncoming" | "loadPersonEvidence" | "loadOwnerName" | "loadActiveEmployer" | "loadLifePhaseOverride">;

export function createThreadStore(supabase: SupabaseClient, company: string): ThreadStoreMethods {
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
  return {
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

    async loadOwnerName() {
      const { data, error } = await supabase
        .from("user_profiles")
        .select("display_name")
        .eq("company_id", company)
        .eq("role", "owner")
        .not("display_name", "is", null)
        .order("created_at", { ascending: true })
        .limit(1);
      if (error) return null;
      const name = ((data ?? []) as { display_name: string | null }[])[0]?.display_name?.trim();
      return name ? name : null;
    },

    async loadActiveEmployer() {
      const { data, error } = await supabase
        .from("employer_pay_profiles")
        .select("employer_name")
        .eq("company_id", company)
        .is("deleted_at", null)
        .is("effective_to", null)
        .order("effective_from", { ascending: false })
        .limit(1);
      // Before 00063 (or on any read trouble) there is simply no stored employer.
      if (error) return null;
      const name = ((data ?? []) as { employer_name: string }[])[0]?.employer_name?.trim();
      return name ? name : null;
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

  };
}
