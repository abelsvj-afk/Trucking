// Task 3.13 (TASKS.md). "Next due"/"overdue" are computed here rather
// than stored or returned by the API (docs/api-contracts.md) - the real
// logic worth getting right and unit-testing, per docs/design/testing.md.

import type { MaintenanceSchedule } from "@/types/entities";

export type DueStatus = "ok" | "due-soon" | "overdue" | "paused" | "unknown";

// "Due soon" starts this many miles/days before the actual due point -
// matches the everyday sense of "coming up," not just "not yet late".
const DUE_SOON_MILES = 1000;
const DUE_SOON_DAYS = 14;

export interface DueStatusResult {
  status: DueStatus;
  nextDueDate: string | null;
  nextDueMileage: number | null;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * currentMileage is the linked truck's current_mileage - null for a
 * trailer schedule (trailers have no mileage column, docs/schemas.md) or
 * a truck whose mileage was never recorded, in which case only the
 * date-based interval (if any) can be evaluated.
 */
export function computeDueStatus(
  schedule: MaintenanceSchedule,
  currentMileage: number | null,
  today: string = new Date().toISOString().slice(0, 10),
): DueStatusResult {
  if (schedule.status === "paused") {
    return { status: "paused", nextDueDate: null, nextDueMileage: null };
  }

  const nextDueDate =
    schedule.interval_days != null && schedule.last_done_date != null
      ? addDays(schedule.last_done_date, schedule.interval_days)
      : null;
  const nextDueMileage =
    schedule.interval_miles != null && schedule.last_done_mileage != null
      ? schedule.last_done_mileage + schedule.interval_miles
      : null;

  const dateResult = nextDueDate == null ? null : dateStatus(nextDueDate, today);
  const mileageResult =
    nextDueMileage == null || currentMileage == null
      ? null
      : mileageStatus(nextDueMileage, currentMileage);

  const status = worseOf(dateResult, mileageResult);

  return { status: status ?? "unknown", nextDueDate, nextDueMileage };
}

function dateStatus(nextDueDate: string, today: string): DueStatus {
  if (today >= nextDueDate) return "overdue";
  if (today >= addDays(nextDueDate, -DUE_SOON_DAYS)) return "due-soon";
  return "ok";
}

function mileageStatus(nextDueMileage: number, currentMileage: number): DueStatus {
  if (currentMileage >= nextDueMileage) return "overdue";
  if (currentMileage >= nextDueMileage - DUE_SOON_MILES) return "due-soon";
  return "ok";
}

// Worse of two statuses wins - a schedule due by either measure is due,
// per the "at least one interval" business rule (docs/design/data-model.md).
const SEVERITY: Record<"ok" | "due-soon" | "overdue", number> = { ok: 0, "due-soon": 1, overdue: 2 };

function worseOf(a: DueStatus | null, b: DueStatus | null): DueStatus | null {
  const candidates = [a, b].filter((s): s is "ok" | "due-soon" | "overdue" => s != null);
  if (candidates.length === 0) return null;
  return candidates.reduce((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst));
}
