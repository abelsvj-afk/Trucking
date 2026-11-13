// The waiting list (docs/design/abel-waiting-list.md, owner 2026-11-12).
// Everything Abel has proposed and not yet been answered on is ONE numbered list. This file is the pure half:
//  - plainSummary(): a stored proposal summary in the driver's words (local times, no record ids, no column
//    names, no file names). Display only - the stored summary and arguments are never changed by it.
//  - parseWaitingAnswers(): his reply to that list, read in CODE. "1. Yes 2. Yes 3. It's active 4. Not sure, no"
//    is four separate answers; an item he said no to can never run, and an item he only commented on is left
//    waiting. The model is not involved in deciding what a yes or a no applies to.

import { FALLBACK_TIME_ZONE, isValidTimeZone } from "@/lib/time";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "CT" / "ET" style label for a zone on a given instant: the short name with the S/D dropped (CST, CDT -> CT). */
function zoneLabel(instant: Date, timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName")?.value;
  if (!part) return "";
  const us = part.match(/^([ECMP])[SD]T$/);
  return us ? `${us[1]}T` : part;
}

/** An instant on the given clock: "Thu Nov 12, 12:00 AM CT". */
export function plainInstant(iso: string, timeZone: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(instant);
  // "Thu, Nov 12, 12:00 AM" -> "Thu Nov 12, 12:00 AM"
  return `${text.replace(/^(\w{3}),/, "$1")} ${zoneLabel(instant, timeZone)}`.trim();
}

/** A calendar day exactly as written, never through a time zone: "2026-11-12" -> "Thu Nov 12". */
function plainDay(day: string): string {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return day;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return `${WEEKDAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** A wall-clock time already written in its own zone: ("2026-11-10", "08:00", zone) -> "Tue Nov 10, 8:00 AM CT". */
function plainWallClock(day: string, hhmm: string, timeZone: string): string {
  const [h, min] = hhmm.split(":").map((n) => Number.parseInt(n, 10)) as [number, number];
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const noon = new Date(`${day}T12:00:00Z`);
  const label = isValidTimeZone(timeZone) ? zoneLabel(noon, timeZone) : "";
  return `${plainDay(day)}, ${hour12}:${String(min).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}${label ? ` ${label}` : ""}`;
}

const ISO_INSTANT = /(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})(?:\s*\(([A-Za-z]+\/[A-Za-z_]+)\))?/g;
const WALL_CLOCK = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) ([A-Za-z]+\/[A-Za-z_]+)/g;
const BARE_DAY = /(?<![\d-])(\d{4}-\d{2}-\d{2})(?![\d-]|T\d)/g;
const UUID = /\s*\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * A stored proposal summary, in the driver's words. Times are shown on the clock the summary names
 * (an appointment written "(America/Chicago)" stays Central); anything else uses `timeZone`
 * (the truck's zone, home fallback). Never UTC.
 */
export function plainSummary(summary: string, timeZone: string = FALLBACK_TIME_ZONE): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : FALLBACK_TIME_ZONE;
  let s = summary;
  // "now 3 stops (a; b; c), becomes 3 stops: a; b; c" - the current stops are noise next to the new ones.
  s = s.replace(/: now \d+ stops? \(.*\), becomes (\d+ stops?:)/s, ": $1");
  s = s.replace(ISO_INSTANT, (all: string, _day: string, _time: string, _off: string, named: string | undefined) =>
    plainInstant(all.split(/\s*\(/)[0]!, named && isValidTimeZone(named) ? named : zone),
  );
  s = s.replace(WALL_CLOCK, (_all, day: string, time: string, named: string) => plainWallClock(day, time, named));
  s = s.replace(BARE_DAY, (_all, day: string) => plainDay(day));
  s = s.replace(/\s*Record id [0-9a-f-]{36}\.?/gi, "");
  s = s.replace(UUID, "");
  s = s.replace(/"?telegram-(photo|document|file)-\d+\.\w+"?/g, "the $1");
  s = s.replace(/\s*\(paper-log helper\)/g, "");
  s = s.replace(/\b(\d+) ([a-z ]+?)\(s\)/gi, (_all, n: string, word: string) => `${n} ${word}${n === "1" ? "" : "s"}`);
  // column and enum names: pickup_window_start -> pickup window start, on_duty -> on duty
  s = s.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (word) => word.replace(/_/g, " "));
  return s.replace(/[ \t]{2,}/g, " ").replace(/\s+([,;:.])/g, "$1").trim();
}

/** One list line: plain words, cut to a readable length (the full detail was shown when it was first proposed). */
export function waitingLine(summary: string, timeZone?: string, max = 220): string {
  const plain = plainSummary(summary, timeZone);
  return plain.length <= max ? plain : `${plain.slice(0, max - 1).trimEnd()}…`;
}

export type ItemAnswer = { kind: "yes" } | { kind: "no" } | { kind: "comment"; text: string };

const DUTY_WORDS: [RegExp, string][] = [
  [/\bdriving\b/i, "driving"],
  [/\boff[\s-]?duty\b/i, "off_duty"],
  [/\bsleeper\b/i, "sleeper"],
  [/\bon[\s-]?duty\b/i, "on_duty"],
];

/**
 * A comment that CONTRADICTS the proposal it answers (Telegram review
 * D2, 2026-11-12): "It's active not complete" against a complete-load
 * proposal, or naming a different duty status than a duty proposal
 * offers. A contradiction is a NO in substance - the proposal is
 * wrong, so it is declined, never left waiting to resurface. A plain
 * comment ("the date is wrong", "check the miles") is not a
 * contradiction: the item stays waiting for a correction.
 */
export function commentContradicts(
  group: { tool_name: string; arguments?: Record<string, unknown> }[],
  text: string,
): boolean {
  const row = group[0];
  if (!row) return false;
  const said = text.trim();
  if (row.tool_name === "complete_load") {
    return /\bnot\s+(complete|completed|done|finished)\b/i.test(said) || /\bstill\s+active\b/i.test(said) || /\bactive,?\s+not\s+complete\b/i.test(said);
  }
  if (row.tool_name === "log_duty_status") {
    const proposed = typeof row.arguments?.duty_status === "string" ? String(row.arguments.duty_status) : null;
    if (!proposed) return false;
    const named = DUTY_WORDS.find(([re]) => re.test(said))?.[1];
    if (named && named !== proposed) return true;
    if (proposed !== "driving" && /\btruck'?s?\s+(is\s+)?moving\b/i.test(said)) return true;
    return false;
  }
  return false;
}

export type WaitingAnswers =
  | { kind: "all"; answer: "yes" | "no" }
  | { kind: "items"; answers: Map<number, ItemAnswer> }
  | { kind: "none" };

const YES = /^(?:yes|yeah|yep|yup|ok|okay|sure|confirm|confirmed|approve|approved|do it|go ahead|record it|s[ií]|dale|correct|right)$/;
const NO = /^(?:no|nope|nah|cancel|drop|drop it|skip|skip it|remove|remove it|delete it|don'?t|never ?mind|forget it|no thanks)$/;

const clean = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[\s.!,;]+$/u, "")
    .replace(/\s+/g, " ");

/** One item's answer. A yes must be the whole answer; any clause that is a plain no makes it a no ("not sure, no"). */
function answerOf(text: string): ItemAnswer {
  const whole = clean(text);
  if (YES.test(whole)) return { kind: "yes" };
  const clauses = whole.split(/\s*[,;]\s*|\s+-\s+/).map(clean).filter(Boolean);
  if (clauses.some((c) => NO.test(c)) && !clauses.some((c) => YES.test(c))) return { kind: "no" };
  return { kind: "comment", text: text.trim().replace(/[\s,;]+$/u, "") };
}

const numbersIn = (text: string) => [...new Set((text.match(/\d+/g) ?? []).map((n) => Number.parseInt(n, 10)))];

/**
 * His reply to a numbered waiting list of `count` items. Recognised forms:
 *   "yes all" / "approve everything" / "drop all" / "none of them"
 *   "1. Yes 2. Yes 3. It's active not complete 4. Not sure, no"   (an answer per number)
 *   "yes to 1 and 2" / "approve 1, 3" / "drop 4" / "no to 2 and 3" (several of these may be joined)
 * Anything else - including a bare "yes", which does not say WHICH - is { kind: "none" }.
 * A number outside 1..count makes the whole reply "none": nothing is guessed.
 */
export function parseWaitingAnswers(text: string, count: number): WaitingAnswers {
  const none: WaitingAnswers = { kind: "none" };
  const whole = clean(text);
  if (!whole || count < 1) return none;

  if (/^(?:(?:yes|yeah|yep|approve|do|record|confirm)(?: to)? (?:all|everything|all of (?:them|it|those))|all(?: of (?:them|it|those))?(?: yes)?|everything)$/.test(whole)) {
    return { kind: "all", answer: "yes" };
  }
  if (/^(?:(?:no|drop|cancel|skip|remove)(?: to)? (?:all|everything|all of (?:them|it|those))|none(?: of (?:them|it|those))?|all no)$/.test(whole)) {
    return { kind: "all", answer: "no" };
  }

  const answers = new Map<number, ItemAnswer>();
  const inRange = (n: number) => n >= 1 && n <= count;

  // An answer per number: every segment starts with its number.
  const marker = /(?:^|\s)(\d{1,2})\s*[.):-]\s*/g;
  const marks = [...text.matchAll(marker)];
  if (marks.length > 0 && text.trim().search(/\d/) === 0) {
    for (let i = 0; i < marks.length; i += 1) {
      const m = marks[i]!;
      const n = Number.parseInt(m[1]!, 10);
      const start = m.index! + m[0].length;
      const end = i + 1 < marks.length ? marks[i + 1]!.index! : text.length;
      const body = text.slice(start, end).trim();
      if (!inRange(n) || !body || answers.has(n)) return none;
      answers.set(n, answerOf(body));
    }
    return answers.size > 0 ? { kind: "items", answers } : none;
  }
  // "1 yes, 2 no" without punctuation after the number
  const loose = [...whole.matchAll(/(\d{1,2}) (yes|yeah|yep|ok|no|nope|drop|cancel|skip)\b/g)];
  if (loose.length > 0 && whole.replace(/(\d{1,2}) (yes|yeah|yep|ok|no|nope|drop|cancel|skip)\b/g, "").replace(/[\s,;.]|and/g, "") === "") {
    for (const m of loose) {
      const n = Number.parseInt(m[1]!, 10);
      if (!inRange(n) || answers.has(n)) return none;
      answers.set(n, /^(?:yes|yeah|yep|ok)$/.test(m[2]!) ? { kind: "yes" } : { kind: "no" });
    }
    return { kind: "items", answers };
  }
  // verb first: "yes to 1 and 2, drop 4"
  const verb = /(yes(?: to)?|approve|record|do|keep|confirm|no(?: to)?|drop|cancel|skip|remove)\s+((?:\d{1,2}(?:\s*(?:,|and|&)\s*)?)+)/g;
  const parts = [...whole.matchAll(verb)];
  if (parts.length > 0 && whole.replace(verb, "").replace(/[\s,;.]|and|but/g, "") === "") {
    for (const m of parts) {
      const answer: ItemAnswer = /^(?:no|drop|cancel|skip|remove)/.test(m[1]!) ? { kind: "no" } : { kind: "yes" };
      for (const n of numbersIn(m[2]!)) {
        if (!inRange(n) || answers.has(n)) return none;
        answers.set(n, answer);
      }
    }
    return answers.size > 0 ? { kind: "items", answers } : none;
  }
  return none;
}

/** The numbered list itself, with how to answer it. Short on purpose: he reads this on a phone, in a truck. */
export function formatWaitingList(lines: string[]): string {
  return (
    `${lines.length} things are waiting on you. Nothing is recorded until you say so:\n` +
    lines.map((line, i) => `${i + 1}. ${line}`).join("\n") +
    `\n\n👉 ${WAITING_LIST_HOWTO}`
  );
}

export const WAITING_LIST_HOWTO = 'Answer by number, like "1 yes, 2 no" — or "yes all" / "drop all".';

/** Shown at the end of every numbered waiting list - also how the next turn knows numbers mean THIS list. */
export const WAITING_LIST_MARK = "Answer by number";

export interface WaitingRowLike {
  id: string;
  tool_name: string;
  summary: string;
  created_at: string;
  batch_id?: string | null;
  item_number?: number | null;
}

/**
 * Open rows as the groups he answers (a batch is one group), oldest first by each group's newest row -
 * the same order the store uses, so a number means the same thing when shown and when answered.
 * Photo-purpose questions and expired proposals are not part of the list.
 */
export function groupWaitingRows<T extends WaitingRowLike>(rows: T[], nowMs: number, expiryMs: number): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    if (row.tool_name === "photo_purpose") continue;
    const key = row.batch_id ?? row.id;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const newest = (g: T[]) => g.reduce((m, r) => (r.created_at > m ? r.created_at : m), g[0]!.created_at);
  return [...groups.values()]
    .map((g) => g.sort((a, b) => (a.item_number ?? 0) - (b.item_number ?? 0)))
    .filter((g) => nowMs - Date.parse(newest(g)) <= expiryMs)
    .sort((a, b) => Date.parse(newest(a)) - Date.parse(newest(b)));
}

/** One group as one line: a single proposal as itself, a batch as its items joined. */
export function groupLine(group: WaitingRowLike[], timeZone?: string): string {
  if (group.length === 1) return waitingLine(group[0]!.summary, timeZone);
  return waitingLine(`${group.length} items — ${group.map((r) => plainSummary(r.summary, timeZone)).join("; ")}`, timeZone, 320);
}
