// Event timelines (owner 2026-11-07, temporal reasoning; design section 8.2): "what happened since Tuesday".
// The pure builder orders and words the events; the loader reads six sources from his records. Dates are calendar
// days on his clock (America/New_York); a source that cannot be read is skipped and named, never silently dropped.

import type { SupabaseClient } from "@supabase/supabase-js";
import { daysBetween, relativeTo } from "@/lib/temporal";
import { formatMoney } from "@/lib/money-format";

export type TimelineTopic = "loads" | "money" | "fuel" | "maintenance" | "documents" | "duty";
export const TIMELINE_TOPICS: readonly TimelineTopic[] = ["loads", "money", "fuel", "maintenance", "documents", "duty"];

export interface TimelineEvent {
  day: string; // YYYY-MM-DD
  /** "9:15 AM" when the source has a time of day. */
  time?: string;
  /** Sort key within a day (ISO timestamp when known). */
  at?: string;
  topic: TimelineTopic;
  text: string;
}

const MAX_LINES = 80;
const dollars = (cents: number) => formatMoney(cents);
const easternDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const easternTime = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const dayHeader = (day: string, today: string) =>
  `📅 ${new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })} (${relativeTo(today, day)})`;

/** Orders events by day then time, filters by topic, and words them under one header per day. */
export function buildTimeline(
  events: TimelineEvent[],
  today: string,
  topics?: TimelineTopic[],
): { text: string; count: number; truncated: boolean } {
  const kept = events
    .filter((e) => !topics || topics.length === 0 || topics.includes(e.topic))
    .sort((a, b) => a.day.localeCompare(b.day) || (a.at ?? "").localeCompare(b.at ?? "") || a.text.localeCompare(b.text));
  if (kept.length === 0) return { text: "Nothing recorded in that window.", count: 0, truncated: false };
  const shown = kept.slice(0, MAX_LINES);
  const out: string[] = [];
  let day = "";
  for (const e of shown) {
    if (e.day !== day) {
      if (day) out.push("");
      out.push(dayHeader(e.day, today));
      day = e.day;
    }
    out.push(`  ${e.time ? `${e.time} - ` : ""}${e.text}`);
  }
  if (kept.length > shown.length) out.push("", `(${kept.length - shown.length} more events after ${shown[shown.length - 1]!.day} not shown - ask for a narrower window.)`);
  return { text: out.join("\n"), count: kept.length, truncated: kept.length > shown.length };
}

type Row = Record<string, unknown>;

async function rows(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row[] | null> {
  try {
    const { data, error } = await query;
    return error ? null : ((data ?? []) as Row[]);
  } catch {
    return null;
  }
}

/** Reads his records between two days (inclusive). Returns the events and the names of any source that could not be read. */
export async function loadTimelineEvents(
  client: SupabaseClient,
  companyId: string,
  from: string,
  to: string,
  today: string,
): Promise<{ events: TimelineEvent[]; unreadable: string[] }> {
  const events: TimelineEvent[] = [];
  const unreadable: string[] = [];
  const fromTs = `${from}T00:00:00-12:00`;
  const toTs = `${to}T23:59:59+14:00`;
  const inRange = (d: string | null | undefined) => typeof d === "string" && d >= from && d <= to;
  const base = (table: string) => client.from(table).select("*").eq("company_id", companyId).is("deleted_at", null);

  // Two plain range queries (picked up in the window, delivered in the window), merged by id.
  const pickedUp = await rows(base("loads").gte("pickup_date", from).lte("pickup_date", to).limit(200));
  const delivered = await rows(base("loads").gte("delivery_date", from).lte("delivery_date", to).limit(200));
  if (!pickedUp || !delivered) unreadable.push("loads");
  const loads = [...new Map([...(pickedUp ?? []), ...(delivered ?? [])].map((l) => [String(l.id), l])).values()];
  for (const l of loads) {
    const route = `${l.origin} → ${l.destination}`;
    const pickup = l.pickup_date as string | null;
    const delivery = l.delivery_date as string | null;
    if (inRange(pickup)) events.push({ day: pickup!, topic: "loads", text: `🚚 ${pickup! <= today ? "Pickup" : "Pickup scheduled"}: ${route}` });
    if (inRange(delivery)) {
      const done = l.status === "completed";
      events.push({ day: delivery!, topic: "loads", text: `🚚 ${done ? "Delivered" : delivery! < today ? "Delivery date passed (not marked delivered)" : "Delivery scheduled"}: ${route}` });
    }
  }

  const expenses = await rows(base("expenses").gte("expense_date", from).lte("expense_date", to).limit(200));
  if (!expenses) unreadable.push("expenses");
  for (const e of expenses ?? []) {
    events.push({ day: e.expense_date as string, topic: "money", text: `🧾 Expense ${dollars(Number(e.amount_cents))} (${e.category})${e.description ? ` - ${String(e.description).slice(0, 60)}` : ""}` });
  }

  const fuel = await rows(base("fuel_purchases").gte("purchased_at", fromTs).lte("purchased_at", toTs).limit(200));
  if (!fuel) unreadable.push("fuel");
  for (const f of fuel ?? []) {
    const at = f.purchased_at as string;
    if (inRange(easternDay(at))) events.push({ day: easternDay(at), at, time: easternTime(at), topic: "fuel", text: `⛽ Fuel ${dollars(Number(f.total_cost_cents))}` });
  }

  const maint = await rows(base("maintenance_events").gte("service_date", from).lte("service_date", to).limit(200));
  if (!maint) unreadable.push("maintenance");
  for (const m of maint ?? []) events.push({ day: m.service_date as string, topic: "maintenance", text: `🔧 Maintenance: ${String(m.description).slice(0, 80)}` });

  const docs = await rows(base("documents").gte("uploaded_at", fromTs).lte("uploaded_at", toTs).limit(200));
  if (!docs) unreadable.push("documents");
  for (const d of docs ?? []) {
    const at = d.uploaded_at as string;
    if (inRange(easternDay(at))) events.push({ day: easternDay(at), at, time: easternTime(at), topic: "documents", text: `📄 Filed: ${d.file_name}` });
  }

  const duty = await rows(base("duty_logs").gte("started_at", fromTs).lte("started_at", toTs).order("started_at", { ascending: true }).limit(120));
  if (!duty) unreadable.push("duty log");
  for (const d of duty ?? []) {
    const at = d.started_at as string;
    if (inRange(easternDay(at))) events.push({ day: easternDay(at), at, time: easternTime(at), topic: "duty", text: `🕒 Duty status: ${String(d.duty_status).replace("_", " ")}` });
  }
  void daysBetween;
  return { events, unreadable };
}
