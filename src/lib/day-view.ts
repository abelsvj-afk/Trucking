// The Hours page's day view (docs/design/driver-hud.md §3): one carrier
// day drawn from duty rows. Pure. A row runs until the next row starts,
// so a day shows the status carried in from the previous day, every
// change inside it, and - for today - stops at "now" (the future is not
// drawn). Nothing before the first row he ever logged is drawn either:
// unknown time stays blank, never a guessed status.

import type { DutyStatus } from "@/types/entities";

export interface DayRow {
  id: string;
  duty_status: DutyStatus;
  started_at: string;
  created_at?: string;
  source?: string | null;
}

export interface DayStretch {
  status: DutyStatus;
  startMin: number;
  endMin: number;
  /** Index into the ascending rows array of the row this stretch belongs to. */
  rowIndex: number;
  /** The row started on an earlier day and runs into this one. */
  carriedIn: boolean;
  /** Ends at "now" - still running. */
  ongoing: boolean;
}

export interface DayView {
  stretches: DayStretch[];
  totals: Record<DutyStatus, number>;
}

const MINUTE = 60_000;

export function sortRows<T extends DayRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
}

export function buildDayView(rows: DayRow[], dayStartMs: number, dayEndMs: number, nowMs: number): DayView {
  const totals: Record<DutyStatus, number> = { off_duty: 0, sleeper: 0, driving: 0, on_duty: 0 };
  const stretches: DayStretch[] = [];
  const limit = Math.min(dayEndMs, nowMs);
  rows.forEach((row, i) => {
    const startMs = Date.parse(row.started_at);
    if (!Number.isFinite(startMs) || startMs >= limit) return;
    const nextMs = i + 1 < rows.length ? Date.parse(rows[i + 1]!.started_at) : Infinity;
    const endMs = Math.min(nextMs, limit);
    const from = Math.max(startMs, dayStartMs);
    if (endMs <= from) return;
    const toMin = (ms: number) => Math.max(0, Math.min(1440, Math.round((ms - dayStartMs) / MINUTE)));
    const stretch: DayStretch = {
      status: row.duty_status,
      startMin: toMin(from),
      endMin: toMin(endMs),
      rowIndex: i,
      carriedIn: startMs < dayStartMs,
      ongoing: endMs === nowMs && nextMs > nowMs,
    };
    if (stretch.endMin > stretch.startMin) {
      stretches.push(stretch);
      totals[row.duty_status] += stretch.endMin - stretch.startMin;
    }
  });
  return { stretches, totals };
}

/** Where a row's start may move without reordering the log or entering the future. */
export function startTimeBounds(rows: DayRow[], rowIndex: number, nowMs: number): { minMs: number; maxMs: number } {
  const prev = rows[rowIndex - 1];
  const next = rows[rowIndex + 1];
  return {
    minMs: prev ? Date.parse(prev.started_at) + MINUTE : -Infinity,
    maxMs: Math.min(next ? Date.parse(next.started_at) - MINUTE : Infinity, nowMs),
  };
}

/** What deleting a row does, in words: the previous status runs on. */
export function deleteConsequence(rows: DayRow[], rowIndex: number): { previous: DutyStatus | null; untilIso: string | null } {
  const prev = rows[rowIndex - 1];
  const next = rows[rowIndex + 1];
  return { previous: prev ? prev.duty_status : null, untilIso: next ? next.started_at : null };
}

/** True when a row was saved more than 5 minutes after the time it claims. */
export function enteredAfterTheFact(row: DayRow): boolean {
  if (!row.created_at) return false;
  return Date.parse(row.created_at) - Date.parse(row.started_at) > 5 * MINUTE;
}
