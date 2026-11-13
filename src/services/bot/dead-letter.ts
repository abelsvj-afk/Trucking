// D12 (Telegram review 2026-11-12): when a persist fails after its retry,
// the record goes here instead of living only in process memory.
//
// A dead letter is the durable copy of a message or pending burst the bot
// could not store in its normal table: kind, the payload verbatim, and the
// error that stopped the write. It is written best-effort and NEVER throws:
// when the 00093 table itself is not applied yet (or the database is down)
// the failure is logged and the caller still warns the owner, so a missing
// dead-letter table can never cost him a turn or hide a lost record.
import type { SupabaseClient } from "@supabase/supabase-js";

export type DeadLetterKind = "message" | "pending_burst";

/** Best-effort dead-letter write. Returns true when the row landed. Never throws. */
export async function saveDeadLetterRow(
  client: SupabaseClient,
  companyId: string,
  kind: DeadLetterKind,
  payload: Record<string, unknown>,
  error: string,
  chatId?: string | number | null,
): Promise<boolean> {
  try {
    const { error: insertError } = await client.from("telegram_dead_letters").insert({
      company_id: companyId,
      chat_id: chatId == null ? null : String(chatId),
      kind,
      payload,
      error,
    });
    if (insertError) {
      console.error("[bot] dead-letter write failed", insertError.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[bot] dead-letter write failed", err instanceof Error ? err.message : err);
    return false;
  }
}
