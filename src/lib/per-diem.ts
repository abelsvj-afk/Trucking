// GAP-16 (Fresh-Eyes Register 2026-11-02) — per-diem day count.
//
// The away-from-home meal deduction is real money at tax time, and
// its evidence is the duty log he already keeps. The counting rule
// (stated plainly, because a deduction count should never be a
// black box):
//  - A date counts when he had driving or on-duty time that day
//    and did NOT end the day at home (his last log of the day being
//    off-duty with "home" in the location/notes marks a return).
//  - Nights between two workdays count too (a 34-hour reset at a
//    truck stop is still away from home): dates with no logs at
//    all, sandwiched 1-3 days between duty dates, count as away.
// Same-day out-and-back (worked, ended at home) does not count.
// The count is an estimate for his preparer to confirm — the app
// assembles the evidence; it does not file.

import type { DutyLog } from "@/types/entities";
import { easternDate } from "./day-wrap";

/**
 * The IRS special per-diem rate for the transportation industry.
 * LABELED AND SINGLE-SOURCED on purpose: verify the current figure
 * (IRS yearly notice on special rates) with his tax preparer and
 * change this one constant — never let a stale rate ride silently.
 * Value: FY2025 transportation-industry rate, $80/day.
 */
export const PER_DIEM_RATE = {
  centsPerDay: 8000,
  label: "IRS special rate, transportation industry (FY2025: $80/day) — verify the current year's figure",
} as const;

const DAY_MS = 86_400_000;

function isWorkStatus(log: DutyLog): boolean {
  return log.duty_status === "driving" || log.duty_status === "on_duty";
}

function endsAtHome(dayLogs: DutyLog[]): boolean {
  const last = [...dayLogs].sort((a, b) => a.started_at.localeCompare(b.started_at)).at(-1);
  if (!last || last.duty_status !== "off_duty") return false;
  const text = `${last.location ?? ""} ${last.notes ?? ""}`.toLowerCase();
  return text.includes("home");
}

export interface PerDiemCount {
  year: number;
  awayDays: number;
  awayDates: string[];
  rateCentsPerDay: number;
  rateLabel: string;
  estimatedDeductionCents: number;
}

export function countPerDiemDays(
  dutyLogs: DutyLog[],
  year: number,
  rateCentsPerDay: number = PER_DIEM_RATE.centsPerDay,
): PerDiemCount {
  const byDate = new Map<string, DutyLog[]>();
  for (const log of dutyLogs) {
    const date = easternDate(new Date(log.started_at));
    if (!date.startsWith(`${year}-`)) continue;
    const list = byDate.get(date) ?? [];
    list.push(log);
    byDate.set(date, list);
  }

  const dutyDates = [...byDate.entries()]
    .filter(([, logs]) => logs.some(isWorkStatus))
    .map(([date]) => date)
    .sort();

  const away = new Set<string>();
  for (const date of dutyDates) {
    if (!endsAtHome(byDate.get(date)!)) away.add(date);
  }
  // Nights between workdays (resets on the road).
  for (let i = 0; i + 1 < dutyDates.length; i++) {
    const a = Date.parse(`${dutyDates[i]}T00:00:00Z`);
    const b = Date.parse(`${dutyDates[i + 1]}T00:00:00Z`);
    const gapDays = Math.round((b - a) / DAY_MS) - 1;
    if (gapDays >= 1 && gapDays <= 3) {
      for (let g = 1; g <= gapDays; g++) {
        away.add(new Date(a + g * DAY_MS).toISOString().slice(0, 10));
      }
    }
  }

  const awayDates = [...away].sort();
  return {
    year,
    awayDays: awayDates.length,
    awayDates,
    rateCentsPerDay,
    rateLabel: PER_DIEM_RATE.label,
    estimatedDeductionCents: awayDates.length * rateCentsPerDay,
  };
}
