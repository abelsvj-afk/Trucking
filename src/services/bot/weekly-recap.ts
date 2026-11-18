// Sunday money recap (owner 2026-11-17: "Do it"). Sunday evening (5-9 PM on his clock), one message: the week's
// miles, the pay those loads earn him, fuel, other business expenses, and what every mile cost. The week is Monday
// to Sunday on his calendar; loads count by delivery date, priced with the same projection as the pay screens.
// Figures come only from his records; a missing one is said, never guessed.

import type { Reminder } from "@/lib/reminders";
import { projectLoad, type ProjectableLoad } from "@/lib/pay-projection";
import { termsForDate, type PayTermsRow } from "@/lib/paycheck";
import { formatMoney } from "@/lib/money-format";
import { zonedDayBounds } from "@/lib/zoned-day";
import type { BotBrainStore } from "./store";
import { localParts } from "./check-in";

export interface WeekNumbers {
  weekStart: string;
  weekEnd: string;
  loads: number;
  miles: number;
  payLowCents: number;
  payHighCents: number;
  unpriced: number;
  fuelCents: number;
  expensesCents: number;
}

/** Due on Sunday between 5 and 9 PM on his clock; returns the Monday that starts the week, or null. */
export function recapDue(nowMs: number, tz: string): { weekStart: string; weekEnd: string } | null {
  const { day, hour } = localParts(nowMs, tz);
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  if (dow !== 0 || hour < 17 || hour >= 21) return null;
  const monday = new Date(Date.parse(`${day}T12:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
  return { weekStart: monday, weekEnd: day };
}

export function composeRecap(w: WeekNumbers): string {
  const pay = w.payLowCents === w.payHighCents ? formatMoney(w.payLowCents) : `${formatMoney(w.payLowCents)} to ${formatMoney(w.payHighCents)}`;
  const cost = w.fuelCents + w.expensesCents;
  const lines = [
    `📊 Your week (Mon ${w.weekStart.slice(5)} – Sun ${w.weekEnd.slice(5)}):`,
    `🚚 ${w.loads} load${w.loads === 1 ? "" : "s"} delivered · ${w.miles.toLocaleString("en-US")} mi`,
    `💵 Pay from them: ${pay}${w.unpriced > 0 ? ` (+${w.unpriced} I can't price yet)` : ""}`,
    `⛽ Fuel: ${formatMoney(w.fuelCents)} · Other expenses: ${formatMoney(w.expensesCents)}`,
  ];
  if (w.miles > 0) lines.push(`📉 Cost per mile: ${formatMoney(Math.round(cost / w.miles))} (fuel + expenses ÷ miles)`);
  else lines.push("📉 Cost per mile: no miles on delivered loads this week, so I can't work it out.");
  if (w.miles > 0 && w.payLowCents > 0) lines.push(`💡 Pay per mile: ${formatMoney(Math.round(w.payLowCents / w.miles))}`);
  return lines.join("\n");
}

export async function planWeeklyRecap(store: BotBrainStore, now: Date, tz: string): Promise<Reminder | null> {
  const due = recapDue(now.getTime(), tz);
  if (!due) return null;
  const startMs = zonedDayBounds(due.weekStart, tz).startMs;
  const endMs = zonedDayBounds(due.weekEnd, tz).endMs;
  const [loadsRes, profilesRes, fuelRes, expRes] = await Promise.all([
    store.client.from("loads").select("*").eq("company_id", store.companyId).is("deleted_at", null).in("status", ["confirmed", "completed"]).gte("delivery_date", due.weekStart).lte("delivery_date", due.weekEnd),
    store.client.from("employer_pay_profiles").select("employer_name, rate_cents_per_mile, mile_basis, percent_of_load_bps, pay_week_ends_on, statement_weekday, payday_weekday, effective_from, effective_to").eq("company_id", store.companyId).is("deleted_at", null),
    store.client.from("fuel_purchases").select("total_cost_cents").eq("company_id", store.companyId).is("deleted_at", null).gte("purchased_at", new Date(startMs).toISOString()).lt("purchased_at", new Date(endMs).toISOString()),
    store.client.from("expenses").select("amount_cents, bucket").eq("company_id", store.companyId).is("deleted_at", null).gte("expense_date", due.weekStart).lte("expense_date", due.weekEnd),
  ]);
  if (loadsRes.error) return null;
  const loads = (loadsRes.data ?? []) as (ProjectableLoad & { delivery_date: string | null; pickup_date: string | null })[];
  const terms = (profilesRes.data ?? []) as unknown as PayTermsRow[];
  let low = 0;
  let high = 0;
  let unpriced = 0;
  for (const l of loads) {
    const t = termsForDate(terms, l.delivery_date ?? l.pickup_date)?.terms;
    const p = t ? projectLoad(t, l) : null;
    if (!p || p.lowCents === null || p.highCents === null) unpriced += 1;
    else {
      low += p.lowCents;
      high += p.highCents;
    }
  }
  const sum = (rows: unknown, key: string) => ((rows ?? []) as Record<string, number | null>[]).reduce((s, r) => s + (Number(r[key]) || 0), 0);
  const expenses = ((expRes.data ?? []) as { amount_cents: number; bucket?: string | null }[]).filter((e) => e.bucket !== "pay_deduction");
  return {
    kind: "checkin",
    key: `recap:${due.weekStart}`,
    critical: false,
    text: composeRecap({
      weekStart: due.weekStart,
      weekEnd: due.weekEnd,
      loads: loads.length,
      miles: loads.reduce((s, l) => s + (l.miles ?? 0), 0),
      payLowCents: low,
      payHighCents: high,
      unpriced,
      fuelCents: fuelRes.error ? 0 : sum(fuelRes.data, "total_cost_cents"),
      expensesCents: sum(expenses, "amount_cents"),
    }),
  };
}
