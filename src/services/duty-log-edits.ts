// Duty-log edit trail (UI/UX spec 2026-11-10 §2.2, migration 00088):
// the ONE writer/reader for duty_log_edits, shared by the duty-log API
// routes, Abel's duty tools, and the paper-log save - every surface
// that corrects a duty entry lands in the same trail.
//
// Honesty model: a correction ALWAYS carries a reason and full
// before/after row snapshots; live logging (a new entry for the status
// starting now) is not a correction and never comes through here.
// The trail is additive storage - HOS math never reads it.
//
// Graceful absence (the codebase's standing rule for a migration this
// branch codes against): on a database where 00088 hasn't landed yet,
// the insert/read fails with a PostgREST error - recordDutyLogEdit
// reports false and fetchDutyLogEdits returns [] instead of breaking
// the duty write itself, which has already landed honestly.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DutyLog, DutyLogEdit, DutyLogEditKind, DutyLogEditSource } from "@/types/entities";

/**
 * Manual clock reset marker (owner 2026-11-17): a hand reset is
 * recorded as a trail row on the latest duty entry, kind "update",
 * whose `after` snapshot carries this key with the reset instant.
 * No migration: the existing duty_log_edits table (00088) already
 * holds it - tenant-isolated under its existing RLS, reason +
 * timestamp recorded, original duty rows untouched. The kind stays
 * "update" because the table's check constraint only allows the four
 * correction kinds; the history renderer (lib/duty-edit-history.ts)
 * recognises this marker and says "Clocks reset" instead of
 * "Entry updated". The HOS engine reads the latest marker back via
 * fetchLatestClockResetAt and re-derives the short clocks from the
 * log of the day the reset was pressed on (DAY-AWARE, owner
 * 2026-11-17): today's driving, on-duty time, breaks and any pending
 * split first period all still count - the reset fixes a wrong
 * derivation, it does not hand him a fresh day. The 60/70 cycle
 * never reads it.
 */
export const CLOCK_RESET_AT = "clock_reset_at";

/** The latest hand-reset instant for the company, or null when none is on record. [] / null on any read failure - the clocks then run from the logs alone, as before. */
export async function fetchLatestClockResetAt(
  client: SupabaseClient,
  companyId: string,
): Promise<string | null> {
  try {
    const { data, error } = await client
      .from("duty_log_edits")
      .select("after, edited_at")
      .eq("company_id", companyId)
      .eq("kind", "update")
      .order("edited_at", { ascending: false })
      .limit(200);
    if (error) return null;
    for (const row of (data ?? []) as { after?: unknown }[]) {
      const after = row.after;
      if (after && typeof after === "object" && typeof (after as Record<string, unknown>)[CLOCK_RESET_AT] === "string") {
        return (after as Record<string, unknown>)[CLOCK_RESET_AT] as string;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Record a hand clock reset in the trail: the latest duty entry's
 * snapshot before, the same snapshot plus the reset instant after.
 * The entry itself is NOT changed - only the trail grows. Returns
 * false (and logs) when the trail write fails; the caller decides
 * whether the reset still stands.
 */
export async function recordClockReset(
  client: SupabaseClient,
  input: { companyId: string; dutyLog: DutyLog; resetAtIso: string; reason: string },
): Promise<boolean> {
  const snapshot: Record<string, unknown> = { ...input.dutyLog };
  return recordDutyLogEdit(client, {
    companyId: input.companyId,
    dutyLogId: input.dutyLog.id,
    kind: "update",
    reason: input.reason,
    before: snapshot,
    after: { ...snapshot, [CLOCK_RESET_AT]: input.resetAtIso },
    source: "app",
  });
}

export interface DutyLogEditInput {
  companyId: string;
  dutyLogId: string;
  kind: DutyLogEditKind;
  reason: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  source?: DutyLogEditSource;
}

/** Writes one trail row. Returns false (and logs) when the trail table isn't there yet or the write fails - never throws over a landed duty write. */
export async function recordDutyLogEdit(
  client: SupabaseClient,
  input: DutyLogEditInput,
): Promise<boolean> {
  try {
    const { error } = await client.from("duty_log_edits").insert({
      company_id: input.companyId,
      duty_log_id: input.dutyLogId,
      kind: input.kind,
      reason: input.reason,
      before: input.before,
      after: input.after,
      source: input.source ?? "app",
    });
    if (error) {
      console.error(`[duty-log-edits] trail write failed (${input.kind} on ${input.dutyLogId}):`, error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[duty-log-edits] trail write failed (${input.kind} on ${input.dutyLogId}):`, err);
    return false;
  }
}

/** The trail for one entry, oldest fix first. [] when there is none - or when the trail table isn't in the database yet. */
export async function fetchDutyLogEdits(
  client: SupabaseClient,
  dutyLogId: string,
): Promise<DutyLogEdit[]> {
  try {
    const { data, error } = await client
      .from("duty_log_edits")
      .select("*")
      .eq("duty_log_id", dutyLogId)
      .order("edited_at", { ascending: true });
    if (error) return [];
    return (data ?? []) as unknown as DutyLogEdit[];
  } catch {
    return [];
  }
}

/** The set of duty-log ids (of the given ids) that carry at least one trail row - the roadside packet's "Edited" wiring. Empty on any read failure. */
export async function fetchEditedDutyLogIds(
  client: SupabaseClient,
  dutyLogIds: string[],
): Promise<Set<string>> {
  if (dutyLogIds.length === 0) return new Set();
  try {
    const { data, error } = await client
      .from("duty_log_edits")
      .select("duty_log_id")
      .in("duty_log_id", dutyLogIds);
    if (error) return new Set();
    return new Set(((data ?? []) as { duty_log_id: string }[]).map((row) => row.duty_log_id));
  } catch {
    return new Set();
  }
}
