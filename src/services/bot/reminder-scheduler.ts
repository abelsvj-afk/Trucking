// Proactive logging reminders - the in-process scheduler (docs/design/
// logging-reminders.md; owner-approved 2026-11-05). Every 5 minutes: if the
// logging_reminders capability is on (no row = off), look at his logged duty
// rows, ask lib/reminders what is due, and message the OWNER only.
//
// Delivery rules: HOS-critical reminders go immediately (quiet hours do not
// hold a safety warning); routine ones wait until quiet hours (21:00-06:00 ET)
// end. Each reminder is sent at most once: the dedupe row is inserted FIRST
// (unique key), the message is sent second, and the row is removed again if
// the send fails so the next tick retries. If the dedupe table is missing or
// unreadable nothing is sent - an unverifiable "not yet sent" must not turn
// into a message every five minutes.

import { composeReminderMessage, evaluateReminders, type Reminder } from "@/lib/reminders";
import { loadHosWindow, toWindowSummary } from "@/services/api/hos-window";
import { getResearchConfig } from "@/services/research/config";
import { isQuietHours } from "@/services/research/delivery";
import { createTelegramBrainStore } from "@/services/telegram/store";
import { createTelegramNotifier } from "@/services/telegram/notify";
import type { BotBrainStore } from "./store";
import { composeCheckIn, dueCheckIn, drivingTodayMs, missingBolLine, yesterdayLogLine, type DutyRow } from "./check-in";
import { thisPayWeekSoFar } from "./pay-projection-tools";
import { planSmartPathWatch, verdictTrust } from "./smart-path-watch";
import { wayHome } from "./way-home";
import { loadMonthIncome } from "@/services/api/monthly-income";
import { getTelegramAppUrl } from "@/services/telegram/cards";
import { runAutoSmartPath } from "@/services/smart-path/auto";
import { groupWaitingRows } from "./waiting-list";
import { computeHudClocks } from "@/lib/hud-clocks";
import { HOME_TIME_ZONE, loadDisplayZone } from "@/lib/display-zone";

export const REMINDER_CHECK_MS = 5 * 60_000;
let started = false;

export interface ReminderDeps {
  store: BotBrainStore | null;
  notify: (text: string) => Promise<boolean>;
  now: () => Date;
  quietHours: (now: Date) => boolean;
}

export type ReminderRunResult = { sent: number; held: number; skipped?: string };

async function claim(store: BotBrainStore, reminder: Reminder): Promise<"claimed" | "already" | "unavailable"> {
  const { error } = await store.client.from("reminder_sends").insert({
    company_id: store.companyId,
    dedupe_key: reminder.key,
    kind: reminder.kind,
  });
  if (!error) return "claimed";
  return /duplicate key|23505|unique/i.test(error.message) || (error as { code?: string }).code === "23505"
    ? "already"
    : "unavailable";
}

async function release(store: BotBrainStore, reminder: Reminder): Promise<void> {
  await store.client
    .from("reminder_sends")
    .delete()
    .eq("company_id", store.companyId)
    .eq("dedupe_key", reminder.key);
}

export async function runRemindersIfDue(overrides: Partial<ReminderDeps> = {}): Promise<ReminderRunResult> {
  try {
    const store =
      overrides.store !== undefined
        ? overrides.store
        : createTelegramBrainStore(process.env.TELEGRAM_COMPANY_ID ?? null);
    if (!store) return { sent: 0, held: 0, skipped: "no telegram store here" };
    if (!(await store.isLoggingRemindersEnabled())) return { sent: 0, held: 0, skipped: "logging_reminders is off" };

    const now = (overrides.now ?? (() => new Date()))();
    const quiet = (overrides.quietHours ?? ((n: Date) => isQuietHours(n, getResearchConfig())))(now);
    const snapshot = await loadHosWindow(store.client, store.companyId, now, "duty_status, started_at");
    const due = evaluateReminders(snapshot.rows, now.getTime(), toWindowSummary(snapshot));
    // The daily check-in (docs/design/abel-do-what-i-ask.md section 6) rides the same tick and the same
    // once-only claim. It never blocks the safety reminders: its own failure is logged and ignored.
    const checkIn = await planCheckIn(store, snapshot, now).catch((err) => {
      console.error("[reminders] check-in planning failed", err);
      return null;
    });
    if (checkIn) due.push(checkIn);
    // Smart Path watch (owner 2026-11-17): re-plan the active load hourly and speak up when the answer changes.
    const watch = await planSmartPathWatch(
      store,
      now,
      async (loadId) => {
        const { data } = await store.client
          .from("reminder_sends")
          .select("dedupe_key")
          .eq("company_id", store.companyId)
          .in("dedupe_key", [`smartpath:${loadId}:late`, `smartpath:${loadId}:not_legal`])
          .limit(1);
        return (data ?? []).length > 0;
      },
      getTelegramAppUrl(),
    ).catch((err) => {
      console.error("[reminders] smart path watch failed", err);
      return null;
    });
    if (watch) due.push(watch);
    const sendable = due.filter((r) => r.critical || !quiet);
    const held = due.length - sendable.length;
    if (sendable.length === 0) return { sent: 0, held };

    const claimed: Reminder[] = [];
    for (const reminder of sendable) {
      const outcome = await claim(store, reminder);
      // A check-in that can't be claimed (e.g. migration 00098 not applied yet) is simply not sent;
      // it must never stop the safety reminders in the same tick.
      if (outcome === "unavailable" && reminder.kind === "checkin") {
        console.error("[reminders] check-in claim refused - skipping the check-in only");
        continue;
      }
      if (outcome === "unavailable") {
        console.error("[reminders] dedupe table unavailable - sending nothing this tick");
        for (const c of claimed) await release(store, c);
        return { sent: 0, held, skipped: "dedupe unavailable" };
      }
      if (outcome === "claimed") claimed.push(reminder);
    }
    if (claimed.length === 0) return { sent: 0, held };

    const notify = overrides.notify ?? ((text: string) => createTelegramNotifier().notifyOwner(text));
    const ok = await notify(composeReminderMessage(claimed));
    if (!ok) {
      for (const c of claimed) await release(store, c);
      console.error("[reminders] Telegram send failed - will retry next tick");
      return { sent: 0, held };
    }
    return { sent: claimed.length, held };
  } catch (err) {
    console.error("[reminders] tick failed", err);
    return { sent: 0, held: 0, skipped: "error" };
  }
}

/** The way home, in the morning check-in, only while the goal load is upcoming or just delivered (no month-long repeats). */
async function homeLineFor(store: BotBrainStore, today: string): Promise<string | null> {
  try {
    const m = await loadMonthIncome(store.client, store.companyId);
    const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    if (!m.goalLoad || m.goalLoad.deliveryDate < yesterday) return null;
    return (await wayHome(store)).text;
  } catch {
    return null;
  }
}

/** Loads delivered today or yesterday with no BOL filed, for the evening check-in. Never fails the check-in. */
async function paperworkLineFor(store: BotBrainStore, today: string): Promise<string | null> {
  try {
    const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const { data: loads, error } = await store.client
      .from("loads")
      .select("id, trip_number, origin, destination, delivery_date, status")
      .eq("company_id", store.companyId)
      .is("deleted_at", null)
      .in("status", ["confirmed", "completed"])
      .gte("delivery_date", yesterday)
      .lte("delivery_date", today);
    if (error || !loads || loads.length === 0) return null;
    const rows = loads as { id: string; trip_number: string | null; origin: string; destination: string; delivery_date: string }[];
    const { data: docs, error: docErr } = await store.client
      .from("documents")
      .select("related_entity_id, doc_type, photo_purpose")
      .eq("company_id", store.companyId)
      .eq("related_entity_type", "load")
      .is("deleted_at", null)
      .in("related_entity_id", rows.map((l) => l.id));
    if (docErr) return null; // can't tell - say nothing rather than nag wrongly
    const covered = new Set(
      ((docs ?? []) as { related_entity_id: string; doc_type: string | null; photo_purpose: string | null }[])
        .filter((d) => d.doc_type === "bol" || d.photo_purpose === "paperwork")
        .map((d) => d.related_entity_id),
    );
    return missingBolLine(
      rows.map((l) => ({ id: l.id, label: l.trip_number ? `Trip ${l.trip_number}` : `${l.origin} → ${l.destination}`, deliveryDate: l.delivery_date })),
      covered,
    );
  } catch {
    return null;
  }
}

/** Smart Path's answer for the active load, one line, for the check-in. Null when there's no load or it can't plan. */
async function smartPathLineFor(store: BotBrainStore, now: Date): Promise<string | null> {
  try {
    const out = await runAutoSmartPath(store.client, store.companyId, {}, now);
    const r = out.result;
    if (!r) return null;
    // Same trust gate as the hourly watch: never declare LATE on shaky inputs — say the verdict is
    // uncertain and name the shaky input instead. No arrival time either: it comes from the same math.
    const trust = verdictTrust(out);
    if (trust.uncertain) {
      return `🧭 Smart Path: can't call it yet — ${trust.reasons.map((s) => s.replace(/\.+$/, "")).join("; ")}.`;
    }
    const word = { on_time: "on time", early: "early", late: "LATE", not_legal: "NOT LEGAL as planned" }[r.verdict.status] ?? r.verdict.status;
    const arrive = r.plan?.arrivalAt
      ? new Date(r.plan.arrivalAt).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) + " ET"
      : null;
    return `🧭 Smart Path: ${word}${arrive ? `, arriving about ${arrive}` : ""}.`;
  } catch {
    return null;
  }
}

/** The check-in due now, as a routine reminder (quiet hours hold it like any routine message), or null. */
async function planCheckIn(store: BotBrainStore, snapshot: Awaited<ReturnType<typeof loadHosWindow>>, now: Date): Promise<Reminder | null> {
  const rows = snapshot.rows as DutyRow[];
  const zone = (await loadDisplayZone(store.client, store.companyId, now.getTime()).catch(() => null))?.timeZone ?? HOME_TIME_ZONE;
  const due = dueCheckIn(rows, now.getTime(), zone);
  if (!due) return null;
  const nextLoadRes = await store.client
    .from("loads")
    .select("trip_number, origin, destination, pickup_date, delivery_date, status")
    .eq("company_id", store.companyId)
    .is("deleted_at", null)
    .eq("status", "confirmed")
    .order("pickup_date", { ascending: true, nullsFirst: false })
    .limit(5);
  const upcoming = ((nextLoadRes.data ?? []) as Record<string, string | null>[]).find((l) => !l.delivery_date || l.delivery_date >= due.day);
  const payWeek = await thisPayWeekSoFar(store, due.day).catch(() => null);
  const waiting = groupWaitingRows(await store.loadOpenPendingRows().catch(() => []), now.getTime(), 2 * 3_600_000).length;
  const text = composeCheckIn({
    kind: due.kind,
    clocks: computeHudClocks(rows, toWindowSummary(snapshot), now.getTime()),
    drivingTodayMs: drivingTodayMs(rows, now.getTime(), zone),
    nextLoad: upcoming
      ? { tripNumber: upcoming.trip_number ?? null, origin: String(upcoming.origin), destination: String(upcoming.destination), pickupDate: upcoming.pickup_date ?? null, deliveryDate: upcoming.delivery_date ?? null }
      : null,
    payWeek: payWeek ? { lowCents: payWeek.lowCents, highCents: payWeek.highCents } : null,
    waitingCount: waiting,
    logLine: due.kind === "morning" ? yesterdayLogLine(rows, now.getTime(), zone) : null,
    smartPathLine: await smartPathLineFor(store, now),
    paperworkLine: due.kind === "evening" ? await paperworkLineFor(store, due.day) : null,
    homeLine: due.kind === "morning" ? await homeLineFor(store, due.day) : null,
  });
  return { kind: "checkin", key: `checkin:${due.kind}:${due.day}`, critical: false, text };
}

export function startReminderScheduler(): void {
  if (started) return;
  started = true;
  void runRemindersIfDue();
  setInterval(() => {
    void runRemindersIfDue();
  }, REMINDER_CHECK_MS);
}
