// Shared time handling (Reliability Unit B - design docs/
// reliability-wave1-design-package.md B.2.1-B.2.3; the package's four
// timezone rules, Rev 4):
//
//   1. HOS calculation: carrier timezone + carrier anchor (lib/
//      hos-periods.ts) - never the viewer's zone.
//   2. HOS display: viewer zone, with the carrier zone and period
//      boundary identified on the surface.
//   3. Financial reporting periods: viewer's local calendar timezone.
//   4. All other user-facing timestamps: viewer's local timezone,
//      unless a feature names another governing zone on its surface.
//
// This module owns rules 2-4's plumbing: discovering the viewer's IANA
// zone, validating a zone parameter server-side with a VISIBLE
// fallback, building datetime-local input values from local wall-clock
// components (never from a UTC ISO slice), and the one shared
// date/datetime formatter pair every surface renders through.
//
// The shared month-bounds helper itself (monthRangeInTimeZone) is
// Unit C's C1 - counted once, there (package B.6 dedup note). B1 lands
// the plumbing it will consume: the client carries its zone, the
// server validates and reports the zone it used.

export const FALLBACK_TIME_ZONE = "America/New_York";

/** True when `tz` is a real IANA timezone name Intl can resolve. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The viewer's IANA timezone, from the runtime's Intl data. Falls back
 * to America/New_York (the owner's zone) when the runtime reports
 * nothing usable - callers that report the zone (B.2.1) surface that
 * fallback rather than hiding it.
 */
export function viewerTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && isValidTimeZone(tz)) return tz;
  } catch {
    // Intl unavailable - fall through to the named fallback.
  }
  return FALLBACK_TIME_ZONE;
}

/**
 * Server-side resolution of a client-supplied `tz` parameter (B.2.1):
 * a valid IANA zone is used as-is; absence or an invalid value falls
 * back to America/New_York AND the caller reports the zone actually
 * used in its response, so the fallback is visible, never silent.
 */
export function resolveViewerTimeZone(param: string | null | undefined): {
  timeZone: string;
  usedFallback: boolean;
} {
  if (param && isValidTimeZone(param)) {
    return { timeZone: param, usedFallback: false };
  }
  return { timeZone: FALLBACK_TIME_ZONE, usedFallback: true };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The value for an <input type="datetime-local"> showing `date` in the
 * viewer's LOCAL wall-clock time (B.2.2 / F-011). Built from local
 * components on purpose: `date.toISOString().slice(0, 16)` renders the
 * UTC wall time instead, which at 8 PM Eastern pre-fills midnight of
 * the NEXT day - the exact defect this helper replaces. Every
 * datetime-local initial value in the app goes through here.
 */
export function localDateTimeInputValue(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

function toDate(value: string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Shared date rendering (B.2.3 / F-012): a stored timestamp rendered as
 * a calendar date in the viewer's zone (or an explicitly named zone).
 * Never a raw ISO string. An unparseable value is returned as-is
 * rather than crashing a list render.
 */
export function formatDate(value: string | Date, timeZone: string = viewerTimeZone()): string {
  const date = toDate(value);
  if (!date) return typeof value === "string" ? value : "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

/**
 * A calendar day ("2026-11-13", a DATE column: delivery, expense,
 * service, due dates) rendered as written: "Nov 13, 2026". It is NOT
 * an instant, so it is never passed through a time zone - formatDate()
 * on a date-only string reads it as UTC midnight and shows the evening
 * before in every US zone (the one-day-early defect, 2026-11-12).
 * Anything that is not a plain YYYY-MM-DD day is returned as given.
 */
export function formatCalendarDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  const [, year, month, date] = match;
  const pinned = new Date(Date.UTC(Number(year), Number(month) - 1, Number(date), 12));
  if (pinned.getUTCDate() !== Number(date)) return day;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(pinned);
}

/**
 * "12:34 PM" when the instant is on today's calendar day in the zone,
 * otherwise the full date and time - so "since 12:34 PM" can never be
 * read as today when it was yesterday.
 */
export function formatSinceTime(
  value: string | Date,
  nowMs: number,
  timeZone: string = viewerTimeZone(),
): string {
  const date = toDate(value);
  if (!date) return typeof value === "string" ? value : "";
  const day = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  if (day(date) === day(new Date(nowMs))) {
    return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
  }
  return formatDateTime(date, timeZone);
}

/** Shared date+time rendering - the formatDate companion (B.2.3). */
export function formatDateTime(value: string | Date, timeZone: string = viewerTimeZone()): string {
  const date = toDate(value);
  if (!date) return typeof value === "string" ? value : "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
