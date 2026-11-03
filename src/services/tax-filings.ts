// GAP-15 + GAP-16 (Fresh-Eyes Register 2026-11-02) — tax & filings
// assembly: the IFTA worksheet and the year-end tax packet, fetched
// once and computed by the pure libs. Used by the API routes and
// Abel's tools so every surface quotes the same numbers.

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildIftaWorksheet, quarterRange, type IftaWorksheet } from "@/lib/ifta";
import { countPerDiemDays, type PerDiemCount } from "@/lib/per-diem";
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
    supabase
      .from("fuel_purchases")
      .select("*")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .gte("purchased_at", `${from}T00:00:00Z`)
      .lte("purchased_at", `${to}T23:59:59Z`),
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
    supabase
      .from("fuel_purchases")
      .select("*")
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .gte("purchased_at", `${from}T00:00:00Z`)
      .lte("purchased_at", `${to}T23:59:59Z`),
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

  const fuel = (fuelResult.data ?? []) as FuelPurchase[];
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
    note: "Assembled from his own records for his tax preparer — per-diem counted by the rule in lib/per-diem.ts at the labeled rate; settlement income (Abel Phase D) joins this packet when settlements exist.",
  };
}
