// The pending-actions slice of the bot store: proposals waiting for the owner's yes
// (bot_pending_actions). A batch is ONE proposal group; a bare yes/no targets the LAST
// group shown, never the oldest (Trip audit P1). Split out of store.ts (decomposition
// pass, behavior-preserving).

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingColumnError } from "./tool-helpers";
import type { BotBrainStore, BotChannel, PendingAction } from "./store";

export type PendingStoreMethods = Pick<BotBrainStore, "loadPendingAction" | "loadPendingBatch" | "dropExpiredPending" | "loadOpenPendingGroups" | "savePendingAction" | "updatePendingAction" | "clearPendingAction" | "clearPendingActions">;

export function createPendingStore(supabase: SupabaseClient, company: string, channel: BotChannel): PendingStoreMethods {
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

  };
}
