// GAP-13 (Fresh-Eyes Register 2026-11-02) — the cash calendar.
//
// Money arrives in lumps (settlements) and leaves on schedules.
// This projects the recurring obligations register forward 30 days
// and buckets them by week, so the collision week is visible
// before it arrives. Warnings attach only to the heaviest week —
// the projection itself stays silent about ordinary weeks.

import type { RecurringObligation } from "@/types/entities";

export interface ObligationOccurrence {
  obligationId: string;
  name: string;
  date: string; // YYYY-MM-DD
  amountCents: number;
}

export interface WeekBucket {
  /** Monday (YYYY-MM-DD) starting the week. */
  weekStart: string;
  totalCents: number;
  occurrences: ObligationOccurrence[];
}

export interface ObligationProjection {
  occurrences: ObligationOccurrence[];
  weeks: WeekBucket[];
  totalCents: number;
  /** The week with the most going out (null when nothing is due). */
  heaviestWeek: WeekBucket | null;
}

const DAY_MS = 86_400_000;

function parseDate(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Monday of the week containing the date (UTC math on ET-supplied dates). */
function weekStartOf(date: string): string {
  const ms = parseDate(date);
  const dow = new Date(ms).getUTCDay(); // 0 = Sunday
  const offset = (dow + 6) % 7; // days since Monday
  return formatDate(ms - offset * DAY_MS);
}

function occurrencesFor(
  obligation: RecurringObligation,
  fromMs: number,
  toMs: number,
): ObligationOccurrence[] {
  const out: ObligationOccurrence[] = [];
  const push = (ms: number) => {
    if (ms >= fromMs && ms < toMs) {
      out.push({
        obligationId: obligation.id,
        name: obligation.name,
        date: formatDate(ms),
        amountCents: obligation.amount_cents,
      });
    }
  };

  if (obligation.cadence === "weekly" || obligation.cadence === "biweekly") {
    const weekday = obligation.weekday ?? 0;
    // Start from the anchor (biweekly) or the window start (weekly).
    let cursor = obligation.anchor_date ? parseDate(obligation.anchor_date) : fromMs;
    while (new Date(cursor).getUTCDay() !== weekday) cursor += DAY_MS;
    const step = obligation.cadence === "weekly" ? 7 * DAY_MS : 14 * DAY_MS;
    // Walk backwards to the window start too (anchor may be ahead).
    while (cursor - step >= fromMs) cursor -= step;
    for (; cursor < toMs; cursor += step) push(cursor);
    return out;
  }

  // Monthly / quarterly / annual: day_of_month clamped to month length.
  const day = Math.min(Math.max(obligation.day_of_month ?? 1, 1), 31);
  const stepMonths = obligation.cadence === "monthly" ? 1 : obligation.cadence === "quarterly" ? 3 : 12;
  const start = new Date(fromMs);
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  // Back up one step so an occurrence early in the window isn't missed.
  month -= stepMonths;
  if (month < 0) {
    month += 12;
    year -= 1;
  }
  for (let i = 0; i < 16; i++) {
    const clamped = Math.min(day, daysInMonth(year, month));
    push(Date.UTC(year, month, clamped));
    month += stepMonths;
    if (month > 11) {
      month -= 12;
      year += 1;
    }
    if (Date.UTC(year, month, 1) >= toMs && i > 2) break;
  }
  return out;
}

/** Project the next `days` days of obligations from `fromDate` (YYYY-MM-DD), bucketed by week. */
export function projectObligations(
  obligations: RecurringObligation[],
  fromDate: string,
  days = 30,
): ObligationProjection {
  const fromMs = parseDate(fromDate);
  const toMs = fromMs + days * DAY_MS;
  const occurrences = obligations
    .filter((o) => o.active)
    .flatMap((o) => occurrencesFor(o, fromMs, toMs))
    .sort((a, b) => a.date.localeCompare(b.date));

  const byWeek = new Map<string, WeekBucket>();
  for (const occurrence of occurrences) {
    const weekStart = weekStartOf(occurrence.date);
    const bucket = byWeek.get(weekStart) ?? { weekStart, totalCents: 0, occurrences: [] };
    bucket.totalCents += occurrence.amountCents;
    bucket.occurrences.push(occurrence);
    byWeek.set(weekStart, bucket);
  }
  const weeks = [...byWeek.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const heaviestWeek = weeks.reduce<WeekBucket | null>(
    (max, w) => (max == null || w.totalCents > max.totalCents ? w : max),
    null,
  );
  return {
    occurrences,
    weeks,
    totalCents: occurrences.reduce((s, o) => s + o.amountCents, 0),
    heaviestWeek,
  };
}
