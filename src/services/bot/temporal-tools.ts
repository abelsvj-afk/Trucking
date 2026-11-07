// Abel's time tools (owner 2026-11-07: "it needs to have temporal reasoning"; design
// docs/design/bot-messages-and-safety.md section 8). Both are READ tools computed in code from "today" on the
// owner's clock (America/New_York): Abel never works out a weekday, a relative date or a day count in its head.

import type { AgentTool } from "@/services/ai/agent-loop";
import { todayEastern } from "@/lib/eastern-date";
import { formatLong, resolveWhen, timeBetween, type Resolved } from "@/lib/temporal";

function describe(phrase: string, r: Resolved): string {
  if (!r.ok) return `"${phrase}": ${r.error}`;
  const lines = [`"${phrase}" = ${r.label} (${r.date}) - ${r.relative}.`];
  if (r.note) lines.push(r.note);
  if (r.alternative) lines.push(`The other possible reading: ${formatLong(r.alternative)} (${r.alternative}). If it matters, say which one you used and let him correct it.`);
  return lines.join(" ");
}

export function buildTemporalTools(): AgentTool[] {
  return [
    {
      name: "when_is",
      description:
        "Turns a date phrase into the real calendar date, computed in code on his clock (America/New_York): today / tomorrow / yesterday, a weekday ('friday', 'next friday', 'last friday'), 'in 3 days', '2 weeks ago', 'the 6th', 'nov 6', '11/6', YYYY-MM-DD, 'end of this week'. ALWAYS use this for any weekday or relative date - never work it out yourself. When the result carries a note or an 'other possible reading', tell him which reading you used. Gives the weekday and how far from today.",
      parameters: {
        type: "object",
        properties: {
          phrase: { type: "string", description: "The date phrase, as he said it." },
          relative_to: { type: "string", description: "Optional YYYY-MM-DD base day for 'N days after ...' (default: today)." },
        },
        required: ["phrase"],
      },
      access: "read",
      async run(args) {
        const today = todayEastern();
        const phrase = String(args.phrase ?? "");
        const base = typeof args.relative_to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.relative_to) ? args.relative_to : today;
        return `Today is ${formatLong(today)} (${today}). ${describe(phrase, resolveWhen(phrase, today, base))}`;
      },
    },
    {
      name: "time_between",
      description:
        "How far apart two days are, computed in code: calendar days, weeks and days, and the weekdays (Mon-Fri) in between, and whether it is in the past or future. Each end can be a date (YYYY-MM-DD) or any phrase when_is understands ('today', 'friday', 'the 6th'). ALWAYS use this for 'how many days until / since' and for deadlines and ages - never count days yourself.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Start day or phrase (default: today)." },
          to: { type: "string", description: "End day or phrase." },
        },
        required: ["to"],
      },
      access: "read",
      async run(args) {
        const today = todayEastern();
        const fromPhrase = typeof args.from === "string" && args.from.trim() ? args.from : "today";
        const toPhrase = String(args.to ?? "");
        const from = resolveWhen(fromPhrase, today);
        const to = resolveWhen(toPhrase, today);
        if (!from.ok) return `Start: ${describe(fromPhrase, from)}`;
        if (!to.ok) return `End: ${describe(toPhrase, to)}`;
        const b = timeBetween(from.date, to.date);
        const span = `${Math.abs(b.days)} day${Math.abs(b.days) === 1 ? "" : "s"}${b.weeks > 0 ? ` (${b.weeks} week${b.weeks === 1 ? "" : "s"}${b.remainderDays ? ` ${b.remainderDays} day${b.remainderDays === 1 ? "" : "s"}` : ""})` : ""}`;
        const dir = b.direction === "same" ? "the same day" : b.direction === "future" ? `${span} later` : `${span} earlier`;
        return [
          `From ${formatLong(from.date)} to ${formatLong(to.date)}: ${dir}.`,
          `Weekdays (Mon-Fri) in between: ${b.weekdays}.`,
          from.ok && from.note ? `Start note: ${from.note}` : "",
          to.ok && to.note ? `End note: ${to.note}` : "",
        ]
          .filter(Boolean)
          .join(" ");
      },
    },
  ];
}
