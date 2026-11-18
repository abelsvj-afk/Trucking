// Detention (owner 2026-11-17: "Do it" - detention tracking). When he's held at a shipper or receiver past the free
// time, Abel says so once, with a note for dispatch he can copy, and when he leaves, the total. Free time is 2 hours
// from his arrival or his appointment, whichever is later (an early arrival doesn't start the clock). It reads the
// stop's arrived / left times (his taps in the app). Abel never sends anything to dispatch himself.

import type { Reminder } from "@/lib/reminders";
import type { BotBrainStore } from "./store";

export const FREE_TIME_MS = 2 * 3_600_000;

export interface DetentionStop {
  id: string;
  label: string;
  arrivedAt: string;
  departedAt: string | null;
  appointmentAt: string | null;
}

/** When detention starts for this stop (arrival or appointment, whichever is later, + 2 h). */
export function detentionStartMs(s: DetentionStop): number {
  const arrived = Date.parse(s.arrivedAt);
  const appt = s.appointmentAt ? Date.parse(s.appointmentAt) : NaN;
  return (Number.isFinite(appt) ? Math.max(arrived, appt) : arrived) + FREE_TIME_MS;
}

const clock = (ms: number, tz: string) => new Date(ms).toLocaleString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
const hm = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

/** The once-only messages due for this stop right now. Pure. */
export function detentionReminders(s: DetentionStop, nowMs: number, tz: string): Reminder[] {
  const start = detentionStartMs(s);
  const arrived = Date.parse(s.arrivedAt);
  const appt = s.appointmentAt ? ` for a ${clock(Date.parse(s.appointmentAt), tz)} appointment` : "";
  const out: Reminder[] = [];
  if (!s.departedAt && nowMs >= start) {
    out.push({
      kind: "checkin",
      key: `detention:${s.id}`,
      critical: false,
      text:
        `⏱️ Detention is running at ${s.label}: you arrived ${clock(arrived, tz)}${appt}, so the 2 free hours ended ${clock(start, tz)}.\n` +
        `Note for dispatch (copy it if you want it):\n` +
        `"At ${s.label} since ${clock(arrived, tz)}${appt}. Still not done as of ${clock(nowMs, tz)} - detention started ${clock(start, tz)}. Please note it on the load."\n` +
        `I'll give you the total when you mark the stop as left.`,
    });
  }
  if (s.departedAt) {
    const left = Date.parse(s.departedAt);
    if (left > start) {
      out.push({
        kind: "checkin",
        key: `detention-end:${s.id}`,
        critical: false,
        text:
          `⏱️ Detention at ${s.label}: ${hm(left - start)} (free time ended ${clock(start, tz)}, you left ${clock(left, tz)}).\n` +
          `Note for dispatch: "Detention at ${s.label}: ${hm(left - start)}, from ${clock(start, tz)} to ${clock(left, tz)}. Arrived ${clock(arrived, tz)}${appt}."`,
      });
    }
  }
  return out;
}

/** Stops he arrived at in the last 2 days that are open, or were left in the last 12 hours. */
export async function planDetention(store: BotBrainStore, now: Date, tz: string): Promise<Reminder[]> {
  const since = new Date(now.getTime() - 48 * 3_600_000).toISOString();
  const { data, error } = await store.client
    .from("load_stops")
    .select("id, load_id, name, address, kind, arrived_at, departed_at, appointment_at")
    .eq("company_id", store.companyId)
    .is("deleted_at", null)
    .gte("arrived_at", since);
  if (error || !data) return [];
  const rows = (data as { id: string; load_id: string; name: string | null; address: string | null; kind: string; arrived_at: string | null; departed_at: string | null; appointment_at: string | null }[])
    .filter((r) => r.arrived_at && (!r.departed_at || now.getTime() - Date.parse(r.departed_at) < 12 * 3_600_000));
  if (rows.length === 0) return [];
  const { data: loads } = await store.client.from("loads").select("id, trip_number").eq("company_id", store.companyId).in("id", [...new Set(rows.map((r) => r.load_id))]);
  const trip = new Map(((loads ?? []) as { id: string; trip_number: string | null }[]).map((l) => [l.id, l.trip_number]));
  return rows.flatMap((r) => {
    const place = r.name ?? r.address ?? (r.kind === "pickup" ? "the shipper" : "the receiver");
    const t = trip.get(r.load_id);
    return detentionReminders(
      { id: r.id, label: `${place}${t ? ` (Trip ${t})` : ""}`, arrivedAt: r.arrived_at!, departedAt: r.departed_at, appointmentAt: r.appointment_at },
      now.getTime(),
      tz,
    );
  });
}
