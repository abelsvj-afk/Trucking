// Staleness (owner 2026-11-07, temporal reasoning; docs/design/bot-messages-and-safety.md section 8.3). Pure.
// Facts go stale. A remembered note carries its age, and a time-bound one ("this week", "today", "currently",
// "active") older than a day is flagged as possibly out of date, so Abel says "as of Tuesday" instead of asserting
// old state as current. Ages are calendar days on the owner's clock (America/New_York).

import { daysBetween } from "@/lib/temporal";

const TIME_BOUND = /\b(today|tonight|tomorrow|yesterday|this (?:week|weekend|morning|afternoon|evening|month)|next week|right now|currently|current|active|at the moment|these days|for now|so far|still waiting|pending|on the road)\b/i;
/** A fact this old always shows its date. */
export const SHOW_AGE_AFTER_DAYS = 7;

const easternDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const shortDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function isTimeBound(content: string): boolean {
  return TIME_BOUND.test(content);
}

/** The note to put beside a remembered fact, or null when it is fresh and not time-bound. */
export function stalenessNote(content: string, createdAt: string, now: Date = new Date()): string | null {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return null;
  const noted = easternDay(created);
  const age = daysBetween(noted, easternDay(now));
  if (age < 0) return null;
  const bound = isTimeBound(content);
  if (bound && age >= 1) {
    return `⚠ time-bound - noted ${age === 1 ? "yesterday" : `${shortDay(noted)}, ${age} days ago`}, may be out of date`;
  }
  if (age >= SHOW_AGE_AFTER_DAYS) return `noted ${shortDay(noted)}, ${age} days ago`;
  return null;
}

/** "- fact (note)" lines for the remembered-facts block. */
export function withAge(content: string, createdAt: string | undefined, now: Date = new Date()): string {
  const note = createdAt ? stalenessNote(content, createdAt, now) : null;
  return note ? `${content} (${note})` : content;
}
