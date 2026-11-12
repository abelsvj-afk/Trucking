// Abel Intelligence Upgrade, Phase D (design §5.4). The weekly
// true-pay report: assembled from the store by CODE (the same
// builder backs the weekly_pay_report tool and the scheduled
// Telegram delivery in pay-report-scheduler.ts, so the number he
// asks for and the number that arrives are the same number).

import type { BotBrainStore } from "./store";
import { buildWeeklyPayReport, type WeeklyReport } from "./pay-truth";
import { formatTwinDigestLine } from "./voice-corpus";
import { todayEastern } from "@/lib/eastern-date";

/**
 * Monday (YYYY-MM-DD) of the week containing `date` ON THE OWNER'S CALENDAR
 * (America/New_York) - the report's week. It used to be the UTC week, so from
 * Sunday 7 PM Eastern (8 PM in summer) "this week" was already the week that
 * had not started for the driver: the weekly_pay_report tool reported the wrong
 * week, and the scheduled report treated a Sunday still in progress as a
 * finished week (defect found 2026-11-12). The day comes from todayEastern();
 * the weekday arithmetic then runs on that calendar day alone, no clock involved.
 */
export function mondayOf(date: Date): string {
  const day = todayEastern(date);
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The last COMPLETED Mon-Sun week's Monday - the scheduled report's target week. */
export function lastCompletedWeekStart(now: Date = new Date()): string {
  return addDays(mondayOf(now), -7);
}

export async function buildWeeklyReportForStore(
  store: BotBrainStore,
  weekStart: string,
): Promise<WeeklyReport & { weekStart: string; weekEnd: string }> {
  const weekEnd = addDays(weekStart, 6);
  const [settlements, completedLoads, pin] = await Promise.all([
    store.listSettlementsInRange(weekStart, weekEnd),
    store.listCompletedLoadsInRange(weekStart, weekEnd),
    store.loadPayPin(),
  ]);
  const report = buildWeeklyPayReport({
    weekLabel: `week of ${weekStart} to ${weekEnd}`,
    settlements,
    completedLoads,
    pin,
  });
  // Phase E: the weekly digest carries the twin's one line when
  // the twin is ON and the week produced measurements - off means
  // no line and no tracking talk (design Phase E acceptance).
  let text = report.text;
  if (await store.isDriverTwinEnabled()) {
    const stats = await store.twinEditStats(`${weekStart}T00:00:00.000Z`, `${weekEnd}T23:59:59.999Z`);
    const twinLine = formatTwinDigestLine(stats);
    if (twinLine) text += `\n${twinLine}`;
  }
  return { ...report, text, weekStart, weekEnd };
}
