// The month's projected pay and the goal (docs/design/monthly-income-goal.md). One loader read by the
// Money → This month page and by Abel's monthly_income tool, so both say the same numbers.

import type { SupabaseClient } from "@supabase/supabase-js";
import { monthIncome, type MonthIncome, type MonthLoad } from "@/lib/monthly-income";
import { termsForDate, type PayTermsRow } from "@/lib/paycheck";
import { todayEastern } from "@/lib/eastern-date";

const PROFILE_COLUMNS =
  "employer_name, rate_cents_per_mile, mile_basis, worker_type, percent_of_load_bps, pay_week_ends_on, statement_weekday, payday_weekday, effective_from, effective_to";

export const GOAL_NOT_APPLIED = "Saving a monthly goal isn't switched on yet: its database update (migration 00099) still needs to be applied.";
const missingTable = (m: string) => /monthly_income_goals|does not exist|schema cache/i.test(m);

export type MonthIncomeView = MonthIncome & {
  hasTerms: boolean;
  goalReady: boolean;
  advancesCents: number;
  deductionsCents: number;
};

const monthEnd = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** The owner-operator's own goal (driver_id null). */
export async function readGoal(client: SupabaseClient, companyId: string): Promise<{ cents: number | null; ready: boolean }> {
  const { data, error } = await client
    .from("monthly_income_goals")
    .select("target_cents")
    .eq("company_id", companyId)
    .is("driver_id", null)
    .is("deleted_at", null)
    .limit(1);
  if (error) {
    if (missingTable(error.message)) return { cents: null, ready: false };
    throw new Error("The monthly goal could not be loaded.");
  }
  const row = (data ?? [])[0] as { target_cents: number } | undefined;
  return { cents: row ? Number(row.target_cents) : null, ready: true };
}

/** Sets (replaces) the goal; null clears it. */
export async function setGoal(client: SupabaseClient, companyId: string, cents: number | null): Promise<void> {
  const now = new Date().toISOString();
  const old = await client
    .from("monthly_income_goals")
    .update({ deleted_at: now })
    .eq("company_id", companyId)
    .is("driver_id", null)
    .is("deleted_at", null);
  if (old.error) throw new Error(missingTable(old.error.message) ? GOAL_NOT_APPLIED : old.error.message);
  if (cents === null) return;
  const { error } = await client.from("monthly_income_goals").insert({ company_id: companyId, target_cents: cents });
  if (error) throw new Error(missingTable(error.message) ? GOAL_NOT_APPLIED : error.message);
}

export async function loadMonthIncome(client: SupabaseClient, companyId: string, month?: string, now: Date = new Date()): Promise<MonthIncomeView> {
  const today = todayEastern(now);
  const m = month && /^\d{4}-\d{2}$/.test(month) ? month : today.slice(0, 7);
  const first = `${m}-01`;
  const last = monthEnd(m);
  const [profiles, loads, advances, deductions, goal] = await Promise.all([
    client.from("employer_pay_profiles").select(PROFILE_COLUMNS).eq("company_id", companyId).is("deleted_at", null),
    client
      .from("loads")
      .select("*")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .in("status", ["confirmed", "completed"])
      .gte("delivery_date", first)
      .lte("delivery_date", last),
    client.from("cash_advances").select("amount_cents").eq("company_id", companyId).is("deleted_at", null).gte("advance_date", first).lte("advance_date", last),
    client.from("expenses").select("amount_cents").eq("company_id", companyId).eq("bucket", "pay_deduction").is("deleted_at", null).gte("expense_date", first).lte("expense_date", last),
    readGoal(client, companyId),
  ]);
  if (profiles.error || loads.error) throw new Error("This month's pay could not be loaded.");
  const rows = (profiles.data ?? []) as unknown as PayTermsRow[];
  const sum = (r: { data: unknown; error: unknown }) =>
    r.error ? 0 : ((r.data ?? []) as { amount_cents: number }[]).reduce((s, x) => s + (x.amount_cents ?? 0), 0);
  const income = monthIncome({
    month: m,
    today,
    loads: (loads.data ?? []) as MonthLoad[],
    termsFor: (l) => termsForDate(rows, l.delivery_date ?? l.pickup_date ?? null)?.terms ?? null,
    goalCents: goal.cents,
  });
  return {
    ...income,
    hasTerms: rows.length > 0,
    goalReady: goal.ready,
    advancesCents: sum(advances),
    deductionsCents: sum(deductions),
  };
}
