// D4 (Telegram review 2026-11-12): the quote IS the pointer.
// When Abel sends a message that renders one or more proposal
// groups, the dispatch layer records (Telegram message id -> the
// group keys rendered in that message) here. When the owner
// replies quoting one of Abel's messages, the turn looks the
// quoted id up FIRST, before the existing newest-group binding.
//
// A group key is a dump batch's batch_id, or a lone single
// proposal's pending-row id - the same keys
// loadOpenPendingGroups() / groupWaitingRows() already use.
// `position` is the group's order as rendered in that message, so
// a numbered answer ("1 yes, 2 no") means the same thing when
// shown and when answered.
//
// Record is best-effort and NEVER throws: a missing table (the
// 00095 migration not applied yet) or a database failure is
// logged and the turn still went out - the mapping is simply
// absent, and a quote then gets the honest one-line "that message
// didn't have anything waiting" answer instead of a wrong
// execution. Lookup THROWS on error, so the caller can tell a
// failed lookup (fail closed: a quoted yes/no executes nothing)
// apart from a message with genuinely no mapping (zero rows).

import type { SupabaseClient } from "@supabase/supabase-js";

const TABLE = "telegram_quote_targets";

/** True when the error is the table not existing yet (migration 00095 not applied). */
function isMissingTableError(error: { message?: string } | null): boolean {
  return Boolean(error?.message && new RegExp(TABLE).test(error.message) && /does not exist|could not find/i.test(error.message));
}

/**
 * Records that Abel's message `messageId` (in `chatId`) rendered
 * `groupKeys`, in that order. One row per (message, group). Best
 * effort: returns true when every row landed, false otherwise.
 * Never throws.
 */
export async function recordQuoteTargets(
  client: SupabaseClient,
  companyId: string,
  chatId: string | number,
  messageIds: number[],
  groupKeys: string[],
): Promise<boolean> {
  if (messageIds.length === 0 || groupKeys.length === 0) return true;
  try {
    const rows = messageIds.flatMap((messageId) =>
      groupKeys.map((groupKey, position) => ({
        company_id: companyId,
        chat_id: String(chatId),
        message_id: messageId,
        group_key: groupKey,
        position,
      })),
    );
    const { error } = await client.from(TABLE).insert(rows);
    if (error) {
      if (isMissingTableError(error)) {
        console.error("[bot] quote-target write skipped - migration 00095 not applied yet");
      } else {
        console.error("[bot] quote-target write failed", error.message);
      }
      return false;
    }
    return true;
  } catch (err) {
    console.error("[bot] quote-target write failed", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * The group keys the message `messageId` rendered, in rendered
 * order. [] when the message rendered no proposal (or the mapping
 * was never recorded). THROWS when the lookup itself fails, so the
 * caller fails closed instead of treating a database error as "no
 * proposal here".
 */
export async function lookupQuoteTargets(
  client: SupabaseClient,
  companyId: string,
  chatId: string | number,
  messageId: number,
): Promise<string[]> {
  const { data, error } = await client
    .from(TABLE)
    .select("group_key, position")
    .eq("company_id", companyId)
    .eq("chat_id", String(chatId))
    .eq("message_id", messageId)
    .is("deleted_at", null)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    if (isMissingTableError(error)) {
      throw new Error("telegram_quote_targets is missing - migration 00095 not applied yet");
    }
    throw new Error(error.message);
  }
  return ((data ?? []) as { group_key: string }[]).map((r) => r.group_key);
}
