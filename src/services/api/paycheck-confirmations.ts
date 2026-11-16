// Paycheck confirmations (docs/design/confirm-paycheck.md, owner 2026-11-16). His word for what landed: one
// confirmation per paycheck (a payday's pay week), the take-home deposit, and optionally his statement.
// applyPaycheckConfirmations is the ONE place a confirmation changes the paycheck picture - the Paychecks page,
// Money and Abel all read the same result. Expected pay is never recalculated here.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PaydayGroup } from "./pay-summary";

export interface PaycheckConfirmation {
  id: string;
  period_start: string;
  period_end: string;
  payday: string | null;
  received_cents: number;
  statement_document_id: string | null;
  source: "app" | "abel";
  confirmed_at: string;
}

const COLUMNS = "id, period_start, period_end, payday, received_cents, statement_document_id, source, confirmed_at";

export const NOT_APPLIED_MESSAGE =
  "Confirming paychecks isn't switched on yet: its database update (migration 00097) still needs to be applied.";

const missingTable = (message: string) => /paycheck_confirmations|does not exist|schema cache/i.test(message);

/** Live confirmations. Before migration 00097 is applied there are none, and the picture reads as before. */
export async function listPaycheckConfirmations(client: SupabaseClient, companyId: string): Promise<PaycheckConfirmation[]> {
  const { data, error } = await client
    .from("paycheck_confirmations")
    .select(COLUMNS)
    .eq("company_id", companyId)
    .is("deleted_at", null);
  if (error) {
    if (missingTable(error.message)) return [];
    throw new Error("The paycheck confirmations could not be loaded.");
  }
  return (data ?? []) as PaycheckConfirmation[];
}

export interface ConfirmInput {
  periodStart: string;
  periodEnd: string;
  payday: string | null;
  receivedCents: number;
  statementDocumentId?: string | null;
  source: "app" | "abel";
}

/** Records (or replaces) the confirmation for one paycheck. */
export async function confirmPaycheck(client: SupabaseClient, companyId: string, input: ConfirmInput): Promise<string> {
  const now = new Date().toISOString();
  const old = await client
    .from("paycheck_confirmations")
    .update({ deleted_at: now })
    .eq("company_id", companyId)
    .eq("period_start", input.periodStart)
    .is("deleted_at", null);
  if (old.error) throw new Error(missingTable(old.error.message) ? NOT_APPLIED_MESSAGE : old.error.message);
  const { data, error } = await client
    .from("paycheck_confirmations")
    .insert({
      company_id: companyId,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      payday: input.payday,
      received_cents: input.receivedCents,
      statement_document_id: input.statementDocumentId ?? null,
      source: input.source,
    })
    .select("id")
    .single();
  if (error) throw new Error(missingTable(error.message) ? NOT_APPLIED_MESSAGE : error.message);
  return String((data as { id: string }).id);
}

/** Undo: the paycheck goes back to whatever the settlement lines say. */
export async function undoPaycheckConfirmation(client: SupabaseClient, companyId: string, periodStart: string): Promise<void> {
  const { error } = await client
    .from("paycheck_confirmations")
    .update({ deleted_at: new Date().toISOString() })
    .eq("company_id", companyId)
    .eq("period_start", periodStart)
    .is("deleted_at", null);
  if (error) throw new Error(missingTable(error.message) ? NOT_APPLIED_MESSAGE : error.message);
}

export type ConfirmedPayday = PaydayGroup & {
  confirmation: { receivedCents: number; confirmedAt: string; statementDocumentId: string | null } | null;
};

/**
 * A confirmed paycheck: received = the deposit he confirmed. At or above the expected take-home (low end) it is
 * paid - nothing unpaid, short or overdue in it. Below, it is short by exactly the difference. Unconfirmed
 * paydays are returned unchanged (with confirmation: null).
 */
export function applyPaycheckConfirmations(paydays: PaydayGroup[], confirmations: PaycheckConfirmation[]): ConfirmedPayday[] {
  const byStart = new Map(confirmations.map((c) => [c.period_start, c]));
  return paydays.map((g) => {
    const c = byStart.get(g.periodStart);
    if (!c) return { ...g, confirmation: null };
    const received = c.received_cents;
    const short = Math.max(0, g.netLowCents - received);
    return {
      ...g,
      receivedCents: received,
      stillOwedLowCents: Math.max(0, g.netLowCents - received),
      stillOwedHighCents: Math.max(0, g.netHighCents - received),
      unpaidCount: 0,
      shortCount: short > 0 ? 1 : 0,
      shortfallCents: short,
      overdue: false,
      confirmation: { receivedCents: received, confirmedAt: c.confirmed_at, statementDocumentId: c.statement_document_id },
    };
  });
}
