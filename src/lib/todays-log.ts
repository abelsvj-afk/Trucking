// Today's log strip data (UI/UX Phase 4, spec §2.4): today's duty
// stretches for Home, derived from the SAME hosWindow rows Home
// already loads — no new fetch. Pure: spans are computed exactly the
// way lib/day-view.ts's buildDayView computes them (a row runs until
// the next row starts, clamped to the carrier-timezone day, today
// stops at "now"), so the strip can never disagree with the Day log
// page about what today contains.

import { sortRows, type DayRow } from "@/lib/day-view";
import { zonedDate, zonedDayBounds } from "@/lib/zoned-day";
import type { DutyStatus } from "@/types/entities";

export interface TodaysLogEntry {
  /** The duty_logs row id — the strip's deep link is ?entry=<id>. */
  id: string;
  status: DutyStatus;
  /** ISO instant this stretch's part of today begins. */
  startIso: string;
  /** ISO instant it ends; null while it is still running ("– now"). */
  endIso: string | null;
  /** The stretch began on an earlier day and runs into today. */
  carriedIn: boolean;
  ongoing: boolean;
}

export function todaysLogEntries(
  rows: DayRow[],
  timeZone: string,
  nowMs: number,
): TodaysLogEntry[] {
  const sorted = sortRows(rows);
  const today = zonedDate(nowMs, timeZone);
  const { startMs, endMs } = zonedDayBounds(today, timeZone);
  const limit = Math.min(endMs, nowMs);
  const entries: TodaysLogEntry[] = [];
  sorted.forEach((row, i) => {
    const startMsRaw = Date.parse(row.started_at);
    if (!Number.isFinite(startMsRaw) || startMsRaw >= limit) return;
    const nextMs = i + 1 < sorted.length ? Date.parse(sorted[i + 1]!.started_at) : Infinity;
    const spanEnd = Math.min(nextMs, limit);
    const from = Math.max(startMsRaw, startMs);
    if (spanEnd <= from) return;
    const ongoing = spanEnd === nowMs && nextMs > nowMs;
    entries.push({
      id: row.id,
      status: row.duty_status,
      startIso: new Date(from).toISOString(),
      endIso: ongoing ? null : new Date(spanEnd).toISOString(),
      carriedIn: startMsRaw < startMs,
      ongoing,
    });
  });
  return entries;
}
