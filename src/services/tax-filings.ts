// GAP-15 + GAP-16 (Fresh-Eyes Register 2026-11-02) — tax & filings
// assembly: the IFTA worksheet and the year-end tax packet, fetched
// once and computed by the pure libs. Used by the API routes and
// Abel's tools so every surface quotes the same numbers.

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildIftaWorksheet, quarterRange, type IftaWorksheet } from "@/lib/ifta";
import { countPerDiemDays, type PerDiemCount } from "@/lib/per-diem";
import { easternDate } from "@/lib/day-wrap";
import type { DutyLog, Expense, FuelPurchase, Load } from "@/types/entities";

export async function getIftaWorksheet(
  supabase: SupabaseClient,
  companyId: string,
  quarter: string,
): Promise<IftaWorksheet> {
  const { from, to } = quarterRange(quarter);
  const windowFrom = new Date(Date.parse(`${from}T00:00:00Z`) - 2 * 86_400_000).toISOString();
  const windowTo = new Date(Date.parse(`${to}T00:00:00Z`) + 3 * 86_400_000).toISOString();
  const [fuelResult, loadsResult, logsResult] = await Promise.all([
    // KR-2 (King review): fuel is fetched on the SAME generous
    // window as the duty logs below — lib/ifta buckets every
    // purchase by its America/New_York date, so exact UTC quarter
    // bounds here silently dropped an ET-evening purchase on the
    // quarter's last day (its UTC timestamp already sits in the
    // next quarter) from a tax-facing worksheet.
    supabase
      .from("fuel_purchases")
      .select("*")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .gte("purchased_at", windowFrom)
      .lt("purchased_at", windowTo),
    supabase
      .from("loads")
      .select("*")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .eq("status", "completed"),
    supabase
      .from("duty_logs")
      .select("*")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .gte("started_at", windowFrom)
      .lt("started_at", windowTo),
  ]);
  if (fuelResult.error) throw new Error(fuelResult.error.message);
  if (loadsResult.error) throw new Error(loadsResult.error.message);
  if (logsResult.error) throw new Error(logsResult.error.message);
  return buildIftaWorksheet(quarter, {
    fuel: (fuelResult.data ?? []) as FuelPurchase[],
    loads: (loadsResult.data ?? []) as Load[],
    dutyLogs: (logsResult.data ?? []) as DutyLog[],
  });
}

export interface TaxPacket {
  year: number;
  perDiem: PerDiemCount;
  fuel: { purchases: number; gallons: number; totalCostCents: number };
  expensesByCategory: Record<string, number>;
  expensesTotalCents: number;
  loadRevenueCents: number;
  completedLoads: number;
  /** UH-09 fix: settlement income actually joined from Abel Phase D's settlements table (driver pay, periods ending in the year). */
  settlementIncomeCents: number;
  settlementsCount: number;
  note: string;
}

export async function getTaxPacket(
  supabase: SupabaseClient,
  companyId: string,
  year: number,
): Promise<TaxPacket> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const [logsResult, fuelResult, expensesResult, loadsResult] = await Promise.all([
    supabase
      .from("duty_logs")
      .select("*")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .gte("started_at", `${year - 1}-12-30T00:00:00Z`)
      .lt("started_at", `${year + 1}-01-03T00:00:00Z`),
    // KR-2 (King review): generous window like the duty logs above;
    // the year is decided in code by each purchase's ET date (the
    // filter after the fetch), so an ET-evening Dec 31 purchase
    // counts in the year it happened on his clock — the same rule
    // the packet's per-diem count already uses.
    supabase
      .from("fuel_purchases")
      .select("*")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .gte("purchased_at", `${year - 1}-12-30T00:00:00Z`)
      .lt("purchased_at", `${year + 1}-01-03T00:00:00Z`),
    supabase
      .from("expenses")
      .select("*")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .gte("expense_date", from)
      .lte("expense_date", to),
    supabase
      .from("loads")
      .select("*")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .eq("status", "completed"),
  ]);
  if (logsResult.error) throw new Error(logsResult.error.message);
  if (fuelResult.error) throw new Error(fuelResult.error.message);
  if (expensesResult.error) throw new Error(expensesResult.error.message);
  if (loadsResult.error) throw new Error(loadsResult.error.message);

  // UH-09 fix: settlements (Abel Phase D) ARE joined now — the note
  // below used to promise this join while no query existed. Missing-
  // table tolerant like day-wrap's Cluster-D reads: a database
  // without the settlements migration yields zero, never a failure.
  let settlementIncomeCents = 0;
  let settlementsCount = 0;
  try {
    const settlementsResult = await supabase
      .from("settlements")
      .select("driver_pay_cents, period_end")
      .eq("company_id", companyId)
      .gte("period_end", from)
      .lte("period_end", to);
    if (!settlementsResult.error) {
      const rows = (settlementsResult.data ?? []) as { driver_pay_cents: number }[];
      settlementsCount = rows.length;
      settlementIncomeCents = rows.reduce((s, r) => s + (r.driver_pay_cents ?? 0), 0);
    }
  } catch {
    // Table absent on this database — packet proceeds without it.
  }

  const fuel = ((fuelResult.data ?? []) as FuelPurchase[]).filter((f) =>
    easternDate(new Date(f.purchased_at)).startsWith(`${year}-`),
  );
  const expenses = (expensesResult.data ?? []) as Expense[];
  const loads = ((loadsResult.data ?? []) as Load[]).filter((l) => {
    const anchor = l.delivery_date ?? l.pickup_date;
    return anchor != null && anchor >= from && anchor <= to;
  });
  const expensesByCategory: Record<string, number> = {};
  for (const expense of expenses) {
    expensesByCategory[expense.category] =
      (expensesByCategory[expense.category] ?? 0) + expense.amount_cents;
  }

  return {
    year,
    perDiem: countPerDiemDays((logsResult.data ?? []) as DutyLog[], year),
    fuel: {
      purchases: fuel.length,
      gallons: Math.round(fuel.reduce((s, f) => s + f.gallons, 0) * 1000) / 1000,
      totalCostCents: fuel.reduce((s, f) => s + f.total_cost_cents, 0),
    },
    expensesByCategory,
    expensesTotalCents: expenses.reduce((s, e) => s + e.amount_cents, 0),
    loadRevenueCents: loads.reduce((s, l) => s + (l.rate_cents ?? 0), 0),
    completedLoads: loads.length,
    settlementIncomeCents,
    settlementsCount,
    note: "Assembled from his own records for his tax preparer — per-diem counted by the rule in lib/per-diem.ts at the labeled rate; settlement income (Abel Phase D, driver pay on settlements whose period ends in the year) is included above when settlements exist.",
  };
}
