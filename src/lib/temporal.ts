// Temporal reasoning for Abel (owner 2026-11-07; docs/design/bot-messages-and-safety.md section 8). Pure: every
// date is a calendar day "YYYY-MM-DD" on the owner's clock; `today` is passed in (America/New_York in the app).
// Abel never does date math in its head - it asks for these answers. Ambiguous phrases say which reading was used
// and give the other candidate, so a wrong guess is visible instead of silent.

const DAY_MS = 86_400_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

const isoToMs = (d: string) => Date.parse(`${d}T12:00:00Z`);
const msToIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => msToIso(isoToMs(d) + n * DAY_MS);
export const dayOfWeek = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const validIso = (y: number, m: number, d: number) => {
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const back = new Date(`${iso}T12:00:00Z`);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? iso : null;
};

/** "Friday, Nov 13, 2026" - the calendar day in words. */
export function formatLong(d: string): string {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((isoToMs(to) - isoToMs(from)) / DAY_MS);
}

/** "today", "tomorrow", "in 6 days", "yesterday", "3 days ago". */
export function relativeTo(today: string, d: string): string {
  const n = daysBetween(today, d);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

/** Monday..Sunday week containing `d`. */
export function weekOf(d: string): { start: string; end: string } {
  const dow = (dayOfWeek(d) + 6) % 7; // Monday = 0
  const start = addDays(d, -dow);
  return { start, end: addDays(start, 6) };
}

export type Resolved =
  | { ok: true; date: string; label: string; relative: string; note: string | null; alternative: string | null }
  | { ok: false; error: string };

const done = (today: string, date: string, note: string | null = null, alternative: string | null = null): Resolved => ({
  ok: true, date, label: formatLong(date), relative: relativeTo(today, date), note, alternative,
});

function monthIndex(token: string): number {
  const t = token.toLowerCase().slice(0, 3);
  return (MONTHS as readonly string[]).indexOf(t);
}

/** Among the same month/day in the neighbouring years, the one nearest `today` (a tie goes to the past). */
function nearestMonthDay(today: string, month: number, day: number): { date: string; other: string | null } | null {
  const y = Number(today.slice(0, 4));
  const candidates = [y - 1, y, y + 1].map((yy) => validIso(yy, month, day)).filter((x): x is string => x !== null);
  if (candidates.length === 0) return null;
  const ranked = candidates.sort((a, b) => Math.abs(daysBetween(today, a)) - Math.abs(daysBetween(today, b)) || daysBetween(today, a) - daysBetween(today, b));
  return { date: ranked[0]!, other: ranked[1] ?? null };
}

/** The same day-of-month in the previous, current and next month - nearest to `today` wins (a tie goes to the past). */
function nearestDayOfMonth(today: string, day: number): { date: string; other: string | null } | null {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const candidates: string[] = [];
  for (const offset of [-1, 0, 1]) {
    const total = y * 12 + (m - 1) + offset;
    const iso = validIso(Math.floor(total / 12), (total % 12) + 1, day);
    if (iso) candidates.push(iso);
  }
  if (candidates.length === 0) return null;
  const ranked = candidates.sort((a, b) => Math.abs(daysBetween(today, a)) - Math.abs(daysBetween(today, b)) || daysBetween(today, a) - daysBetween(today, b));
  return { date: ranked[0]!, other: ranked[1] ?? null };
}

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const toNumber = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUMBER_WORDS[s] ?? NaN);

/** Resolves a spoken/typed date phrase against `today` (and optionally a different base day for "N days after X"). */
export function resolveWhen(input: string, today: string, base: string = today): Resolved {
  const text = String(input ?? "").trim().toLowerCase().replace(/[.,!?]+$/g, "").replace(/\s+/g, " ");
  if (!text) return { ok: false, error: "no date phrase given" };

  // exact dates
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m) {
    const iso = validIso(Number(m[1]), Number(m[2]), Number(m[3]));
    return iso ? done(today, iso) : { ok: false, error: `${text} is not a real calendar date` };
  }
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(text);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (m[3]) {
      const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      const iso = validIso(year, month, day);
      return iso ? done(today, iso) : { ok: false, error: `${text} is not a real calendar date` };
    }
    const near = nearestMonthDay(today, month, day);
    return near ? done(today, near.date, "No year given, so the nearest one to today was used.", near.other) : { ok: false, error: `${text} is not a real calendar date` };
  }
  m = /^(?:the )?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/.exec(text);
  if (m) {
    const month = monthIndex(m[1]!) + 1;
    const day = Number(m[2]);
    if (m[3]) {
      const iso = validIso(Number(m[3]), month, day);
      return iso ? done(today, iso) : { ok: false, error: `${text} is not a real calendar date` };
    }
    const near = nearestMonthDay(today, month, day);
    return near ? done(today, near.date, "No year given, so the nearest one to today was used.", near.other) : { ok: false, error: `${text} is not a real calendar date` };
  }
  m = /^(?:the )?(\d{1,2})(?:st|nd|rd|th)$/.exec(text) ?? /^(?:the )(\d{1,2})$/.exec(text);
  if (m) {
    const day = Number(m[1]);
    const near = day >= 1 && day <= 31 ? nearestDayOfMonth(today, day) : null;
    return near
      ? done(today, near.date, "Only a day of the month was given, so the occurrence nearest to today was used (a tie goes to the past).", near.other)
      : { ok: false, error: `there is no day ${day} near ${today}` };
  }

  // fixed words
  const fixed: Record<string, number> = { today: 0, tonight: 0, "this morning": 0, "this afternoon": 0, "this evening": 0, now: 0, tomorrow: 1, yesterday: -1, "day after tomorrow": 2, "the day after tomorrow": 2, "day before yesterday": -2, "the day before yesterday": -2, "last night": -1 };
  if (text in fixed) return done(today, addDays(today, fixed[text]!));

  // relative: "in 3 days", "3 days from now", "3 days ago", "a week ago", "2 weeks from today", "3 days after the 6th"
  m = /^(?:in )?(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+) (day|week|month)s?(?: (ago|from now|from today|later|before|after)(?: (.+))?)?$/.exec(text);
  if (m) {
    const n = toNumber(m[1]!);
    if (Number.isFinite(n)) {
      const unit = m[2]!;
      const dir = m[3] ?? "from now";
      const anchorText = m[4];
      let anchor = base;
      if (anchorText) {
        const a = resolveWhen(anchorText, today, base);
        if (!a.ok) return a;
        anchor = a.date;
      }
      const sign = dir === "ago" || dir === "before" ? -1 : 1;
      if (unit === "month") {
        const y = Number(anchor.slice(0, 4));
        const mo = Number(anchor.slice(5, 7)) - 1 + sign * n;
        const yy = y + Math.floor(mo / 12);
        const mm = ((mo % 12) + 12) % 12 + 1;
        const dd = Number(anchor.slice(8, 10));
        const exact = validIso(yy, mm, dd);
        if (exact) return done(today, exact);
        const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
        return done(today, validIso(yy, mm, lastDay)!, `That month has no day ${dd}, so its last day was used.`);
      }
      return done(today, addDays(anchor, sign * n * (unit === "week" ? 7 : 1)));
    }
  }

  // weeks: "this week", "next week", "last week", "start/end of this week", "end of next week"
  m = /^(?:the )?(start|beginning|end) of (this|next|last) week$/.exec(text) ?? /^(this|next|last) week(?:'s)? (monday|sunday)$/.exec(text);
  if (m) {
    const which = (m[2] && ["this", "next", "last"].includes(m[2]) ? m[2] : m[1])!;
    const edge = m[1] && ["start", "beginning", "end"].includes(m[1]) ? m[1] : m[2] === "monday" ? "start" : "end";
    const shift = which === "next" ? 7 : which === "last" ? -7 : 0;
    const w = weekOf(addDays(today, shift));
    return done(today, edge === "end" ? w.end : w.start, "Weeks run Monday to Sunday here.");
  }

  // weekdays: "friday", "this friday", "on friday", "next friday", "last friday"
  m = /^(?:on )?(?:(this|next|last|coming|past) )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(text);
  if (m) {
    const which = m[1] ?? "this";
    const target = (WEEKDAYS as readonly string[]).indexOf(m[2]!);
    const todayDow = dayOfWeek(today);
    const ahead = (target - todayDow + 7) % 7; // 0 = today
    if (which === "last" || which === "past") {
      const back = ((todayDow - target + 7) % 7) || 7;
      return done(today, addDays(today, -back));
    }
    if (which === "next") {
      // the weekday in the FOLLOWING Monday-Sunday week
      const nextWeek = weekOf(addDays(today, 7));
      const date = addDays(nextWeek.start, (target + 6) % 7);
      const coming = addDays(today, ahead);
      return done(today, date, `"Next ${m[2]}" is read as the ${m[2]} of NEXT week.`, coming !== date ? coming : null);
    }
    return done(today, addDays(today, ahead), ahead === 0 ? "That is today." : null);
  }

  return { ok: false, error: `I can't read "${input}" as a date - try a weekday, "in 3 days", "the 6th", "Nov 6" or YYYY-MM-DD` };
}

export interface Between {
  days: number;
  weeks: number;
  remainderDays: number;
  weekdays: number;
  direction: "future" | "past" | "same";
}

/** How far apart two days are: calendar days, weeks + days, and the Monday-Friday days in between (end exclusive, start inclusive). */
export function timeBetween(from: string, to: string): Between {
  const days = daysBetween(from, to);
  const abs = Math.abs(days);
  const [a, b] = days >= 0 ? [from, to] : [to, from];
  let weekdays = 0;
  for (let i = 0; i < abs; i += 1) {
    const dow = dayOfWeek(addDays(a, i));
    if (dow !== 0 && dow !== 6) weekdays += 1;
  }
  void b;
  return { days, weeks: Math.floor(abs / 7), remainderDays: abs % 7, weekdays, direction: days > 0 ? "future" : days < 0 ? "past" : "same" };
}
