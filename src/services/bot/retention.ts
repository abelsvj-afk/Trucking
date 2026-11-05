// Retention (owner decision D-8, 2026-11-05): conversation messages are kept
// 12 months, then retired. "Retired" = soft-deleted (deleted_at set): they
// leave every read path but the rows stay recoverable in the database; this
// never hard-deletes. Positions are already latest-only (driver_positions);
// superseded memories, summaries and research signals are kept until the owner
// names a reason. Runs inside the memory_consolidation night shift, so it is
// behind that switch (off = nothing is retired).

import type { SupabaseClient } from "@supabase/supabase-js";

export const MESSAGE_RETENTION_DAYS = 365;
/** Bounded per night so a first run over a big backlog stays gentle. */
export const RETIRE_BATCH = 500;

export async function retireOldMessages(
  client: SupabaseClient,
  companyId: string,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - MESSAGE_RETENTION_DAYS * 86_400_000).toISOString();
  const { data, error } = await client
    .from("telegram_messages")
    .select("id")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(RETIRE_BATCH);
  if (error) throw new Error(error.message);
  const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return 0;
  const { error: updateError } = await client
    .from("telegram_messages")
    .update({ deleted_at: now.toISOString() })
    .eq("company_id", companyId)
    .in("id", ids);
  if (updateError) throw new Error(updateError.message);
  return ids.length;
}
