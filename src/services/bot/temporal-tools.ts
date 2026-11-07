// Abel's time tools (owner 2026-11-07: "it needs to have temporal reasoning"; design
// docs/design/bot-messages-and-safety.md section 8). All READ tools, computed in code from "today" on the owner's
// clock (America/New_York): Abel never works out a weekday, a relative date, a day count, a timeline, a deadline or
// a load calendar in its head.
//   when_is / time_between  - date phrases (including pay-period phrases from his saved terms) and spans
//   timeline                - what happened between two days
//   whats_due               - what is coming up or overdue
//   load_calendar           - his booked loads in order, with overlaps, gaps and deadheads

import type { AgentTool } from "@/services/ai/agent-loop";
import type { BotBrainStore } from "./store";
import { todayEastern } from "@/lib/eastern-date";
import { addDays, formatLong, resolveWhen, timeBetween, type Resolved } from "@/lib/temporal";
import { formatSequence, sequenceLoads, type SequenceLoad } from "@/lib/load-sequence";
import { loadPayCalendarTerms, resolvePayPhrase } from "./pay-phrases";
import { buildTimeline, loadTimelineEvents, TIMELINE_TOPICS, type TimelineTopic } from "./timeline";
import { buildDeadlines, loadDueItems } from "./deadlines";

function describe(phrase: string, r: Resolved): string {
  if (!r.ok) return `"${phrase}": ${r.error}`;
  const lines = [`"${phrase}" = ${r.label} (${r.date}) - ${r.relative}.`];
  if (r.note) lines.push(r.note);
  if (r.alternative) lines.push(`The other possible reading: ${formatLong(r.alternative)} (${r.alternative}). If it matters, say which one you used and let him correct it.`);
  return lines.join(" ");
}

const PAY_HINT = /pay|statement/i;

export function buildTemporalTools(store: BotBrainStore): AgentTool[] {
  const { client, companyId } = store;

  /** Date phrase -> day, pay-period phrases included (terms are read only when the phrase mentions pay). */
  async function resolve(phrase: string, today: string, base: string = today): Promise<Resolved> {
    if (PAY_HINT.test(phrase)) {
      const terms = await loadPayCalendarTerms(client as never, companyId, today);
      const pay = resolvePayPhrase(phrase, today, terms);
      if (pay) return pay;
    }
    return resolveWhen(phrase, today, base);
  }

  return [
    {
      name: "when_is",
      description:
        "Turns a date phrase into the real calendar date, computed in code on his clock (America/New_York): today / tomorrow / yesterday, a weekday ('friday', 'next friday', 'last friday'), 'in 3 days', '2 weeks ago', 'the 6th', 'nov 6', '11/6', YYYY-MM-DD, 'end of this week' - and his PAY calendar from his saved pay terms: 'payday', 'next payday', 'last payday', 'statement day', 'end of the pay week'. ALWAYS use this for any weekday, relative date or pay date - never work it out yourself. When the result carries a note or an 'other possible reading', tell him which reading you used. Gives the weekday and how far from today.",
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
        return `Today is ${formatLong(today)} (${today}). ${describe(phrase, await resolve(phrase, today, base))}`;
      },
    },
    {
      name: "time_between",
      description:
        "How far apart two days are, computed in code: calendar days, weeks and days, and the weekdays (Mon-Fri) in between, and whether it is in the past or future. Each end can be a date (YYYY-MM-DD) or any phrase when_is understands ('today', 'friday', 'the 6th', 'next payday'). ALWAYS use this for 'how many days until / since' and for deadlines and ages - never count days yourself.",
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
        const from = await resolve(fromPhrase, today);
        const to = await resolve(toPhrase, today);
        if (!from.ok) return `Start: ${describe(fromPhrase, from)}`;
        if (!to.ok) return `End: ${describe(toPhrase, to)}`;
        const b = timeBetween(from.date, to.date);
        const span = `${Math.abs(b.days)} day${Math.abs(b.days) === 1 ? "" : "s"}${b.weeks > 0 ? ` (${b.weeks} week${b.weeks === 1 ? "" : "s"}${b.remainderDays ? ` ${b.remainderDays} day${b.remainderDays === 1 ? "" : "s"}` : ""})` : ""}`;
        const dir = b.direction === "same" ? "the same day" : b.direction === "future" ? `${span} later` : `${span} earlier`;
        return [
          `From ${formatLong(from.date)} to ${formatLong(to.date)}: ${dir}.`,
          `Weekdays (Mon-Fri) in between: ${b.weekdays}.`,
          from.note ? `Start note: ${from.note}` : "",
          to.note ? `End note: ${to.note}` : "",
        ]
          .filter(Boolean)
          .join(" ");
      },
    },
    {
      name: "timeline",
      description:
        "What happened between two days, in order, from his real records: loads (pickups and deliveries), expenses, fuel, maintenance, documents filed and duty-status changes - each day with its weekday and how long ago. Use for 'what happened since Tuesday', 'what did I do last week', 'walk me through this week'. since / until are date phrases (until defaults to today); topics optionally narrows it. Never reconstruct history from memory - call this.",
      parameters: {
        type: "object",
        properties: {
          since: { type: "string", description: "Start day or phrase, e.g. 'tuesday', 'last friday', 'nov 1'." },
          until: { type: "string", description: "End day or phrase (default today)." },
          topics: { type: "array", items: { type: "string", enum: [...TIMELINE_TOPICS] }, description: "Optional: only these kinds of events." },
        },
        required: ["since"],
      },
      access: "read",
      async run(args) {
        const today = todayEastern();
        const sincePhrase = String(args.since ?? "");
        const untilPhrase = typeof args.until === "string" && args.until.trim() ? args.until : "today";
        const since = await resolve(sincePhrase, today);
        const until = await resolve(untilPhrase, today);
        if (!since.ok) return `Since: ${describe(sincePhrase, since)}`;
        if (!until.ok) return `Until: ${describe(untilPhrase, until)}`;
        const [from, to] = since.date <= until.date ? [since.date, until.date] : [until.date, since.date];
        if (addDays(from, 92) < to) return "That window is longer than 92 days - ask for a narrower one.";
        const topics = Array.isArray(args.topics) ? (args.topics.filter((t): t is TimelineTopic => (TIMELINE_TOPICS as readonly string[]).includes(String(t)))) : undefined;
        const { events, unreadable } = await loadTimelineEvents(client, companyId, from, to, today);
        const built = buildTimeline(events, today, topics);
        return [
          `Timeline ${formatLong(from)} to ${formatLong(to)}:`,
          built.text,
          unreadable.length ? `(Could not read: ${unreadable.join(", ")} - those are missing from the list above.)` : "",
        ].filter(Boolean).join("\n");
      },
    },
    {
      name: "whats_due",
      description:
        "What is coming up or overdue, soonest first, with days left: credentials expiring, recurring bills, maintenance due by date, and his booked loads' pickup/delivery dates (including a delivery date that has passed without the load being marked delivered). Use for 'what's coming up', 'anything due this week', 'what did I miss'. within_days defaults to 30 (max 365).",
      parameters: { type: "object", properties: { within_days: { type: "number", description: "How far ahead to look (default 30)." } } },
      access: "read",
      async run(args) {
        const today = todayEastern();
        const within = typeof args.within_days === "number" ? Math.max(1, Math.min(365, Math.floor(args.within_days))) : 30;
        const { items, unreadable } = await loadDueItems(client, companyId, today, within);
        const built = buildDeadlines(items, today, within);
        return [`As of ${formatLong(today)}:`, built.text, unreadable.length ? `(Could not read: ${unreadable.join(", ")} - not included.)` : ""].filter(Boolean).join("\n");
      },
    },
    {
      name: "load_calendar",
      description:
        "His booked loads in calendar order with the problems a driver needs to see: a pickup before the previous delivery (overlap), a same-day turnaround, long idle gaps, a load that ends somewhere other than where the next one starts (deadhead), and loads with no dates. Covers confirmed loads from 3 days ago through the next `days` (default 21). Use for 'how does my week look', 'do I have time to take this', 'any conflicts'.",
      parameters: { type: "object", properties: { days: { type: "number", description: "How many days ahead (default 21, max 120)." } } },
      access: "read",
      async run(args) {
        const today = todayEastern();
        const days = typeof args.days === "number" ? Math.max(1, Math.min(120, Math.floor(args.days))) : 21;
        const from = addDays(today, -3);
        const to = addDays(today, days);
        const { data, error } = await client
          .from("loads")
          .select("id, origin, destination, status, pickup_date, delivery_date")
          .eq("company_id", companyId)
          .is("deleted_at", null)
          .in("status", ["confirmed", "completed"])
          .order("pickup_date", { ascending: true, nullsFirst: false })
          .limit(150);
        if (error) throw new Error(error.message);
        const inWindow = ((data ?? []) as SequenceLoad[]).filter((l) => {
          const start = l.pickup_date ?? l.delivery_date;
          const end = l.delivery_date ?? l.pickup_date;
          if (!start || !end) return l.status === "confirmed"; // undated confirmed loads are worth showing
          return end >= from && start <= to;
        });
        return `Load calendar ${formatLong(from)} to ${formatLong(to)}:\n${formatSequence(sequenceLoads(inWindow))}`;
      },
    },
  ];
}
