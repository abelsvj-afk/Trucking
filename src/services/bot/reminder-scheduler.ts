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
    const sendable = due.filter((r) => r.critical || !quiet);
    const held = due.length - sendable.length;
    if (sendable.length === 0) return { sent: 0, held };

    const claimed: Reminder[] = [];
    for (const reminder of sendable) {
      const outcome = await claim(store, reminder);
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

export function startReminderScheduler(): void {
  if (started) return;
  started = true;
  void runRemindersIfDue();
  setInterval(() => {
    void runRemindersIfDue();
  }, REMINDER_CHECK_MS);
}
