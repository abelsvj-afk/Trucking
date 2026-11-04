// Reliability Unit C, task C1 (design C.3): the SHARED summary filter
// module. The financial-summary endpoint and the F-010 detail endpoint
// both take their date windows from here, so the components can never
// quietly use different months (F-010's original defect shape) and the
// month is the VIEWER-LOCAL month (F-007), consuming the timezone
// plumbing Unit B shipped (resolveViewerTimeZone / viewerTimeZone in
// lib/time.ts).
//
// Two window shapes, by column kind:
// - plain `date` columns (loads.delivery_date, expenses.expense_date,
//   maintenance_events.service_date) compare against the local dates
//   [from, to] inclusively - a date has no timezone, the viewer's
//   month IS those dates;
// - the `timestamptz` column (fuel_purchases.purchased_at) compares
//   against the UTC instants of viewer-local midnights:
//   [midnight(from), midnight(day after to)) - so a purchase at 11pm
//   viewer time on the last day of the month is in the month, and one
//   at 1am on the 1st of next month is not, whatever the server zone.

export type SummaryComponent = "revenue" | "expenses" | "fuel" | "maintenance";

export const SUMMARY_COMPONENTS: readonly SummaryComponent[] = [
  "revenue",
  "expenses",
  "fuel",
  "maintenance",
];

export function isSummaryComponent(value: string | null): value is SummaryComponent {
  return value !== null && (SUMMARY_COMPONENTS as readonly string[]).includes(value);
}

/** Inclusive viewer-local date range, "YYYY-MM-DD" strings. */
export interface SummaryRange {
  from: string;
  to: string;
}

export interface ComponentWindow extends SummaryRange {
  /** UTC instant of viewer-local midnight on `from` (fuel window open). */
  fromTs: string;
  /** UTC instant of viewer-local midnight on the day after `to` (fuel window close, exclusive). */
  toTs: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateString(value: string): boolean {
  return DATE_RE.test(value);
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  return dt.toISOString().slice(0, 10);
}

/** The calendar date ("YYYY-MM-DD") an instant falls on in `timeZone`. */
export function localDateOfInstant(instantMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Offset (local-as-UTC minus UTC) of `timeZone` at an instant, in ms. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const localAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return localAsUtc - Math.floor(instantMs / 1000) * 1000;
}

/** The UTC instant (ms) of viewer-local midnight on `dateStr`. */
export function zonedMidnightUtcMs(dateStr: string, timeZone: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const utcMidnight = Date.UTC(y!, m! - 1, d!);
  let guess = utcMidnight;
  // Two passes settle the offset even across a DST transition at
  // midnight; a third confirms stability.
  for (let i = 0; i < 3; i++) {
    const next = utcMidnight - zoneOffsetMs(guess, timeZone);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** The viewer-local calendar month containing `nowMs`. */
export function monthRangeInZone(timeZone: string, nowMs: number): SummaryRange {
  const todayLocal = localDateOfInstant(nowMs, timeZone);
  const [y, m] = todayLocal.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const mm = String(m!).padStart(2, "0");
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(lastDay).padStart(2, "0")}` };
}

/** Expand a date range into the full component window for `timeZone`. */
export function componentWindow(range: SummaryRange, timeZone: string): ComponentWindow {
  return {
    ...range,
    fromTs: new Date(zonedMidnightUtcMs(range.from, timeZone)).toISOString(),
    toTs: new Date(zonedMidnightUtcMs(addDays(range.to, 1), timeZone)).toISOString(),
  };
}

/** Where an incurred date falls relative to a range (string-safe for dates). */
export function classifyIncurred(dateStr: string, range: SummaryRange): "before" | "in" | "after" {
  if (dateStr < range.from) return "before";
  if (dateStr > range.to) return "after";
  return "in";
}
