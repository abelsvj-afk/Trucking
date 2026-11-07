// What is coming up or overdue (owner 2026-11-07, temporal reasoning; design section 8.4): one list, soonest first,
// with days left - credentials expiring, recurring bills, maintenance due by date, and his booked loads' dates.
// Reuses the existing credential, obligation and maintenance logic; this only gathers and words it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, daysBetween, formatLong } from "@/lib/temporal";
import { projectObligations } from "@/lib/obligations";
import { computeDueStatus } from "@/lib/maintenance-schedule";
import type { MaintenanceSchedule, RecurringObligation } from "@/types/entities";

export type DueKind = "credential" | "bill" | "maintenance" | "load";

export interface DueItem {
  date: string;
  kind: DueKind;
  text: string;
}

const ICON: Record<DueKind, string> = { credential: "🪪", bill: "🧾", maintenance: "🔧", load: "🚚" };

/** Splits into overdue and upcoming (within the window) and words each line with how far away it is. */
export function buildDeadlines(items: DueItem[], today: string, withinDays: number): { text: string; overdue: number; upcoming: number } {
  const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date) || a.text.localeCompare(b.text));
  const overdue = sorted.filter((i) => i.date < today);
  const upcoming = sorted.filter((i) => i.date >= today && daysBetween(today, i.date) <= withinDays);
  if (overdue.length === 0 && upcoming.length === 0) return { text: `Nothing due or overdue in the next ${withinDays} days.`, overdue: 0, upcoming: 0 };
  const short = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const lines: string[] = [];
  if (overdue.length > 0) {
    lines.push("🔴 OVERDUE");
    for (const i of overdue) {
      const n = -daysBetween(today, i.date);
      lines.push(`  ${ICON[i.kind]} ${n} day${n === 1 ? "" : "s"} overdue (${short(i.date)}) - ${i.text}`);
    }
  }
  if (upcoming.length > 0) {
    if (lines.length) lines.push("");
    lines.push(`⏰ COMING UP (next ${withinDays} days)`);
    for (const i of upcoming) {
      const n = daysBetween(today, i.date);
      lines.push(`  ${ICON[i.kind]} ${n === 0 ? "TODAY" : n === 1 ? "tomorrow" : `in ${n} days`} (${short(i.date)}) - ${i.text}`);
    }
  }
  return { text: lines.join("\n"), overdue: overdue.length, upcoming: upcoming.length };
}

type Row = Record<string, unknown>;
const get = async (q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row[] | null> => {
  try {
    const { data, error } = await q;
    return error ? null : ((data ?? []) as Row[]);
  } catch {
    return null;
  }
};

export async function loadDueItems(
  client: SupabaseClient,
  companyId: string,
  today: string,
  withinDays: number,
): Promise<{ items: DueItem[]; unreadable: string[] }> {
  const items: DueItem[] = [];
  const unreadable: string[] = [];
  const horizon = addDays(today, withinDays);
  const base = (table: string) => client.from(table).select("*").eq("company_id", companyId).is("deleted_at", null);

  const credentials = await get(base("credentials").lte("expires_on", horizon));
  if (!credentials) unreadable.push("credentials");
  for (const c of credentials ?? []) items.push({ date: c.expires_on as string, kind: "credential", text: `${c.label ?? c.kind} expires` });

  const obligations = await get(base("recurring_obligations"));
  if (!obligations) unreadable.push("recurring bills");
  else {
    const projected = projectObligations(obligations as unknown as RecurringObligation[], today, withinDays);
    for (const o of projected.occurrences) items.push({ date: o.date, kind: "bill", text: `${o.name} $${(o.amountCents / 100).toFixed(2)} due` });
  }

  const schedules = await get(base("maintenance_schedules"));
  if (!schedules) unreadable.push("maintenance schedules");
  for (const s of schedules ?? []) {
    const due = computeDueStatus(s as unknown as MaintenanceSchedule, null, today);
    if (due.nextDueDate && due.nextDueDate <= horizon) items.push({ date: due.nextDueDate, kind: "maintenance", text: `${s.description} due` });
  }

  const loads = await get(base("loads").eq("status", "confirmed").limit(100));
  if (!loads) unreadable.push("loads");
  for (const l of loads ?? []) {
    const route = `${l.origin} → ${l.destination}`;
    const pickup = l.pickup_date as string | null;
    const delivery = l.delivery_date as string | null;
    if (pickup && pickup >= today && pickup <= horizon) items.push({ date: pickup, kind: "load", text: `pickup ${route}` });
    if (delivery && delivery <= horizon) {
      items.push({ date: delivery, kind: "load", text: delivery < today ? `delivery date passed, not marked delivered: ${route}` : `delivery ${route}` });
    }
  }
  void formatLong;
  return { items, unreadable };
}
