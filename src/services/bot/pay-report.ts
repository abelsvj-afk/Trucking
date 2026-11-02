// Abel Intelligence Upgrade, Phase D (design §5.4). The weekly
// true-pay report: assembled from the store by CODE (the same
// builder backs the weekly_pay_report tool and the scheduled
// Telegram delivery in pay-report-scheduler.ts, so the number he
// asks for and the number that arrives are the same number).

import type { BotBrainStore } from "./store";
import { buildWeeklyPayReport, type WeeklyReport } from "./pay-truth";

/** Monday (YYYY-MM-DD) of the week containing `date`, UTC - the report's week key. (Weeks are labeled with their dates in the report text; the key only needs to be stable across machines.) */
export function mondayOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = d.getUTCDay(); // 0 = Sunday
  const delta = (dow + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - delta);
  return d.toISOString().slice(0, 10);
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
  return { ...report, weekStart, weekEnd };
}
