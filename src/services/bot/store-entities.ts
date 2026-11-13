// The thread-memory slice of the bot store (Telegram fix round,
// migration 00083): durable pending bursts (ChatGPT T-002) and the
// per-thread entity index (brief fixes 10/11/11A).
//
// Both halves are BEST-EFFORT by contract, like the update-claim
// table before them: before migration 00083 lands - or on any store
// trouble - bursts degrade to the in-memory collector and resolution
// degrades to plain database lookups. A failed write here must never
// cost the owner a turn; a failed read must never invent a record.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BotBrainStore, BotChannel } from "./store";
import { saveDeadLetterRow } from "./dead-letter";

export type ThreadEntityStoreMethods = Pick<
  BotBrainStore,
  | "savePendingBurst"
  | "loadPendingBurst"
  | "claimDuePendingBursts"
  | "claimPendingBurst"
  | "clearPendingBurst"
  | "releasePendingBurstClaim"
  | "upsertThreadEntity"
  | "listThreadEntities"
  | "markThreadEntityCurrent"
>;

const missingTable = (error: { message?: string } | null, table: string): boolean =>
  Boolean(error?.message && new RegExp(table).test(error.message) && /does not exist|could not find/i.test(error.message));

export function createThreadMemoryStore(
  supabase: SupabaseClient,
  company: string,
  channel: BotChannel,
): ThreadEntityStoreMethods {
  return {
    // --- durable pending bursts -----------------------------------
    async savePendingBurst(chatId, items, dueAtIso) {
      const row = {
        company_id: company,
        chat_id: chatId,
        items,
        due_at: dueAtIso,
        claimed_at: null,
        updated_at: new Date().toISOString(),
      };
      const save = () => supabase.from("telegram_pending_bursts").upsert(row, { onConflict: "company_id,chat_id" });
      let { error } = await save();
      if (error && !missingTable(error, "telegram_pending_bursts")) {
        // D12: one retry, then a dead letter. The in-memory copy still
        // holds the bundle for this process, but the dead letter is the
        // durable copy - a restart no longer loses it silently.
        ({ error } = await save());
      }
      if (error && !missingTable(error, "telegram_pending_bursts")) {
        await saveDeadLetterRow(supabase, company, "pending_burst", { items, due_at: dueAtIso }, error.message, chatId);
        console.error("[bot] pending burst save failed (dead-lettered; in-memory copy still holds it)", error.message);
      }
    },

    async loadPendingBurst(chatId) {
      const { data, error } = await supabase
        .from("telegram_pending_bursts")
        .select("items, due_at")
        .eq("company_id", company)
        .eq("chat_id", chatId)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) {
        if (!missingTable(error, "telegram_pending_bursts")) console.error("[bot] pending burst read failed", error.message);
        return null;
      }
      if (!data) return null;
      const row = data as { items: unknown; due_at: string };
      return { items: Array.isArray(row.items) ? row.items : [], dueAt: row.due_at };
    },

    async claimDuePendingBursts(nowIso, staleClaimBeforeIso) {
      const { data, error } = await supabase
        .from("telegram_pending_bursts")
        .select("id, chat_id, items, claimed_at")
        .eq("company_id", company)
        .is("deleted_at", null)
        .lte("due_at", nowIso)
        .order("due_at", { ascending: true })
        .limit(10);
      if (error) {
        if (!missingTable(error, "telegram_pending_bursts")) console.error("[bot] due burst scan failed", error.message);
        return [];
      }
      const claimed: { chatId: string; items: unknown[] }[] = [];
      for (const raw of (data ?? []) as { id: string; chat_id: string; items: unknown; claimed_at: string | null }[]) {
        if (raw.claimed_at !== null && raw.claimed_at >= staleClaimBeforeIso) continue; // freshly claimed elsewhere
        // Atomic-ish claim: the update only lands while the row is
        // still unclaimed (or still holds the stale claim we saw).
        let q = supabase
          .from("telegram_pending_bursts")
          .update({ claimed_at: nowIso })
          .eq("id", raw.id)
          .eq("company_id", company);
        q = raw.claimed_at === null ? q.is("claimed_at", null) : q.eq("claimed_at", raw.claimed_at);
        const { data: updated, error: claimError } = await q.select("id");
        if (claimError) {
          if (!missingTable(claimError, "telegram_pending_bursts")) console.error("[bot] burst claim failed", claimError.message);
          continue;
        }
        if (Array.isArray(updated) && updated.length > 0) {
          claimed.push({ chatId: raw.chat_id, items: Array.isArray(raw.items) ? raw.items : [] });
        }
      }
      return claimed;
    },

    async claimPendingBurst(chatId) {
      const nowIso = new Date().toISOString();
      const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
      const { data, error } = await supabase
        .from("telegram_pending_bursts")
        .select("id, claimed_at")
        .eq("company_id", company)
        .eq("chat_id", chatId)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) {
        if (!missingTable(error, "telegram_pending_bursts")) console.error("[bot] pending burst claim read failed", error.message);
        return true; // nothing readable to coordinate - proceed in-memory
      }
      if (!data) return true; // no persisted copy - nothing to coordinate
      const row = data as { id: string; claimed_at: string | null };
      if (row.claimed_at !== null && row.claimed_at >= staleBefore) return false; // a sweep owns it, freshly
      let q = supabase
        .from("telegram_pending_bursts")
        .update({ claimed_at: nowIso })
        .eq("id", row.id)
        .eq("company_id", company);
      q = row.claimed_at === null ? q.is("claimed_at", null) : q.eq("claimed_at", row.claimed_at);
      const { data: updated, error: claimError } = await q.select("id");
      if (claimError) {
        if (!missingTable(claimError, "telegram_pending_bursts")) console.error("[bot] pending burst claim failed", claimError.message);
        return true;
      }
      return Array.isArray(updated) && updated.length > 0;
    },

    async clearPendingBurst(chatId) {
      const { error } = await supabase
        .from("telegram_pending_bursts")
        .delete()
        .eq("company_id", company)
        .eq("chat_id", chatId);
      if (error && !missingTable(error, "telegram_pending_bursts")) {
        console.error("[bot] pending burst clear failed", error.message);
      }
    },

    async releasePendingBurstClaim(chatId) {
      const { error } = await supabase
        .from("telegram_pending_bursts")
        .update({ claimed_at: null })
        .eq("company_id", company)
        .eq("chat_id", chatId);
      if (error && !missingTable(error, "telegram_pending_bursts")) {
        console.error("[bot] pending burst claim release failed", error.message);
      }
    },

    // --- the thread entity index ----------------------------------
    async upsertThreadEntity(entry) {
      try {
        const nowIso = new Date().toISOString();
        if (entry.isCurrent) {
          await supabase
            .from("bot_thread_entities")
            .update({ is_current: false })
            .eq("company_id", company)
            .eq("chat_id", entry.chatId)
            .eq("is_current", true)
            .is("deleted_at", null);
        }
        // Find the row this entry extends: same record id, or any
        // shared key (a staged trip is keyed by trip number long
        // before its load row - and id - exists).
        const { data: existing } = await supabase
          .from("bot_thread_entities")
          .select("id, keys, entity_id")
          .eq("company_id", company)
          .eq("chat_id", entry.chatId)
          .eq("entity_type", entry.entityType)
          .is("deleted_at", null)
          .limit(50);
        const norm = (v: string) => v.trim().toLowerCase();
        const match = ((existing ?? []) as { id: string; keys: unknown; entity_id: string | null }[]).find((row) => {
          if (entry.entityId && row.entity_id === entry.entityId) return true;
          const rowKeys = Array.isArray(row.keys) ? (row.keys as { kind: string; value: string }[]) : [];
          return entry.keys.some((k) => rowKeys.some((rk) => rk.kind === k.kind && norm(rk.value) === norm(k.value)));
        });
        if (match) {
          const prior = Array.isArray(match.keys) ? (match.keys as { kind: string; value: string }[]) : [];
          const merged = [...prior];
          for (const k of entry.keys) {
            if (!merged.some((p) => p.kind === k.kind && norm(p.value) === norm(k.value))) merged.push(k);
          }
          const { error } = await supabase
            .from("bot_thread_entities")
            .update({
              keys: merged,
              label: entry.label,
              entity_id: entry.entityId ?? match.entity_id,
              is_current: entry.isCurrent ?? undefined,
              last_seen_at: nowIso,
              updated_at: nowIso,
            })
            .eq("id", match.id)
            .eq("company_id", company);
          if (error && !missingTable(error, "bot_thread_entities")) console.error("[bot] thread entity update failed", error.message);
          return;
        }
        const { error } = await supabase.from("bot_thread_entities").insert({
          company_id: company,
          channel,
          chat_id: entry.chatId,
          entity_type: entry.entityType,
          entity_id: entry.entityId,
          keys: entry.keys,
          label: entry.label,
          is_current: entry.isCurrent ?? false,
          last_seen_at: nowIso,
        });
        if (error && !missingTable(error, "bot_thread_entities")) console.error("[bot] thread entity insert failed", error.message);
      } catch (err) {
        console.error("[bot] thread entity upsert failed", err instanceof Error ? err.message : "error");
      }
    },

    async listThreadEntities(chatId, limit = 100) {
      const { data, error } = await supabase
        .from("bot_thread_entities")
        .select("id, entity_type, entity_id, keys, label, is_current, last_seen_at")
        .eq("company_id", company)
        .eq("chat_id", chatId)
        .is("deleted_at", null)
        .order("last_seen_at", { ascending: false })
        .limit(limit);
      if (error) {
        if (!missingTable(error, "bot_thread_entities")) console.error("[bot] thread entity list failed", error.message);
        return [];
      }
      return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        id: String(row.id),
        entityType: row.entity_type as ThreadEntityRow["entityType"],
        entityId: (row.entity_id as string | null) ?? null,
        keys: Array.isArray(row.keys) ? (row.keys as ThreadEntityRow["keys"]) : [],
        label: String(row.label),
        isCurrent: row.is_current === true,
        lastSeenAt: String(row.last_seen_at),
      }));
    },

    async markThreadEntityCurrent(chatId, rowId) {
      try {
        await supabase
          .from("bot_thread_entities")
          .update({ is_current: false })
          .eq("company_id", company)
          .eq("chat_id", chatId)
          .eq("is_current", true)
          .is("deleted_at", null);
        const { error } = await supabase
          .from("bot_thread_entities")
          .update({ is_current: true, last_seen_at: new Date().toISOString() })
          .eq("id", rowId)
          .eq("company_id", company);
        if (error && !missingTable(error, "bot_thread_entities")) console.error("[bot] thread entity current-mark failed", error.message);
      } catch (err) {
        console.error("[bot] thread entity current-mark failed", err instanceof Error ? err.message : "error");
      }
    },
  };
}

export interface ThreadEntityRow {
  id: string;
  entityType: "load" | "document" | "truck" | "trailer" | "driver";
  entityId: string | null;
  keys: { kind: string; value: string }[];
  label: string;
  isCurrent: boolean;
  lastSeenAt: string;
}
