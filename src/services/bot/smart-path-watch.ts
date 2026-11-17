// Smart Path doesn't wait to be opened (owner 2026-11-17: "Smart Path shouldn't wait on me, and Abel should use
// it"). Once an hour, while a load is active, the SAME automatic planner the page uses re-plans the run from the
// truck's latest position and his hours; when the answer turns LATE or NOT LEGAL - or comes back to on time
// after that - Abel says so once, with why. Delivered through the reminder scheduler (routine: quiet hours hold
// it; reminder_sends makes each alert once-only). Planning only, not the ELD.

import type { BotBrainStore } from "./store";
import type { Reminder } from "@/lib/reminders";
import { runAutoSmartPath, type AutoRunResult } from "@/services/smart-path/auto";
import { hoursLine } from "@/lib/smart-path-summary";

export const WATCH_EVERY_MS = 60 * 60_000;
const lastRun = new Map<string, number>();

const WORD: Record<string, string> = { on_time: "ON TIME", early: "EARLY", late: "LATE", not_legal: "NOT LEGAL AS PLANNED" };
const BAD = new Set(["late", "not_legal"]);

/** The alert for this plan, or null when there is nothing to say. Pure; the dedupe key makes it once-only. */
export function watchAlert(out: AutoRunResult, appUrl: string | null): Reminder | null {
  const r = out.result;
  if (!r || !out.load) return null;
  const status = r.verdict.status;
  const why = r.verdict.tradeoffLines[0] ?? r.verdict.legalLines[0] ?? "";
  const hours = hoursLine(r);
  const link = appUrl ? ` Open Smart Path: ${appUrl.replace(/\/+$/, "")}/smart-path` : "";
  if (BAD.has(status)) {
    return {
      kind: "checkin",
      key: `smartpath:${out.load.id}:${status}`,
      critical: false,
      text:
        `⚠️ Smart Path: ${out.load.label} is now ${WORD[status]}. ${why}` +
        (hours ? `\n${hours.text}` : "") +
        (hours?.fromAppLog && hours.tight ? "\nIf your log is behind, tell me what you actually did and I'll fix it." : "") +
        link +
        "\n(Planning only - not your ELD.)",
    };
  }
  // Back on time after a warning: said once per load per recovery (the key names the status it recovered to).
  return {
    kind: "checkin",
    key: `smartpath:${out.load.id}:ok`,
    critical: false,
    text: `✅ Smart Path: ${out.load.label} is back ${WORD[status] ?? "on time"}. ${why}${link}`,
  };
}

/**
 * Runs the planner at most once an hour per company. Returns the alert to send, or null. The "back on time" alert
 * only goes out when a bad-status alert for this load was already sent (checked by the caller's dedupe table).
 */
export async function planSmartPathWatch(
  store: BotBrainStore,
  now: Date,
  wasWarned: (loadId: string) => Promise<boolean>,
  appUrl: string | null,
): Promise<Reminder | null> {
  const last = lastRun.get(store.companyId);
  if (last !== undefined && now.getTime() - last < WATCH_EVERY_MS) return null;
  lastRun.set(store.companyId, now.getTime());
  const out = await runAutoSmartPath(store.client, store.companyId, {}, now);
  const alert = watchAlert(out, appUrl);
  if (!alert || !out.load) return null;
  if (alert.key.endsWith(":ok") && !(await wasWarned(out.load.id))) return null;
  return alert;
}

/** For tests: forget the hourly throttle. */
export function resetSmartPathWatch(): void {
  lastRun.clear();
}
