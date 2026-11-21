// Cash advances by talking to Abel (owner 2026-11-21: "Had two 200 dollar bag advances this pay
// period" was turned into a $400 paycheck confirmation for the PREVIOUS payday — Abel had no
// advance tool, so the model used the nearest one).
//
// One write, proposed first like every other: each advance is recorded in cash_advances — the same
// rows as Money → Advances — dated the day it was taken. The app's own rule then decides which
// paycheck it comes out of (lib/cash-advances.ts groupAdvancesByWeek): the pay week CONTAINING the
// advance's date, under his pay terms (Sunday–Saturday today), deducted from THAT week's payday
// (the Friday after). So an advance taken this week comes out of NEXT Friday's check, never the
// check that already landed. The proposal and the reply both say which payday, from that rule.

import type { AgentTool } from "@/services/ai/agent-loop";
import { groupAdvancesByWeek } from "@/lib/cash-advances";
import { todayEastern } from "@/lib/eastern-date";
import { formatMoney } from "@/lib/money-format";
import { formatCalendarDay } from "@/lib/time";
import { loadPaySummary } from "@/services/api/pay-summary";
import { fetchPayTerms } from "@/services/api/pay-terms";
import type { BotBrainStore } from "./store";

const MAX_ADVANCES = 10;
const MAX_ADVANCE_CENTS = 5_000_00;

interface AdvanceArg {
  amount_cents: number;
  advance_date: string;
}

function parseArgs(args: Record<string, unknown>, today: string): { ok: true; advances: AdvanceArg[]; note: string | null } | { ok: false; error: string } {
  const list = Array.isArray(args.advances) ? args.advances : [];
  if (list.length === 0) return { ok: false, error: "list each advance he took (amount, and the date if he said it)" };
  if (list.length > MAX_ADVANCES) return { ok: false, error: `at most ${MAX_ADVANCES} advances at a time` };
  const advances: AdvanceArg[] = [];
  for (const raw of list) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const dollars = typeof r.amount_dollars === "number" ? r.amount_dollars : Number.parseFloat(String(r.amount_dollars ?? "").replace(/[$,]/g, ""));
    const cents = Math.round(dollars * 100);
    if (!Number.isFinite(dollars) || cents <= 0 || cents > MAX_ADVANCE_CENTS) return { ok: false, error: "each advance needs its amount in dollars (more than $0)" };
    const date = typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : today;
    if (date > today) return { ok: false, error: "an advance can't be dated in the future - ask him which day he took it" };
    advances.push({ amount_cents: cents, advance_date: date });
  }
  const note = typeof args.note === "string" && args.note.trim() ? args.note.trim().slice(0, 200) : null;
  return { ok: true, advances, note };
}

export function buildCashAdvanceTools(store: BotBrainStore): AgentTool[] {
  const { client, companyId } = store;

  /** "2 advances, $400.00 — out of the Fri Nov 27 paycheck (pay week Nov 15 to Nov 21)", per payday, from the app's rule. */
  async function whereTheyLand(advances: AdvanceArg[]): Promise<string> {
    const terms = await fetchPayTerms(client, companyId);
    return groupAdvancesByWeek(advances, terms)
      .map((w) => {
        const n = w.advances.length;
        const out = w.payday ? `out of the ${formatCalendarDay(w.payday)} paycheck` : "out of that week's paycheck (payday not set in Pay settings)";
        return `${n} advance${n === 1 ? "" : "s"}, ${formatMoney(w.totalCents)} — ${out} (pay week ${formatCalendarDay(w.start)} to ${formatCalendarDay(w.end)})`;
      })
      .join("; ");
  }

  return [
    {
      name: "record_cash_advance",
      description:
        "He took a cash advance (a 'bag advance', a draw, money taken out against his pay) - e.g. 'had two $200 advances this pay period'. " +
        "This is NOT a paycheck: never use confirm_paycheck for advances. Pass one entry per advance (two $200 advances = two entries of 200). " +
        "Pass each date (YYYY-MM-DD) if he said it; leave it out when he didn't and it is dated today. " +
        "The app decides which paycheck it comes out of: the pay week containing its date (this week's advances come out of NEXT payday's check).",
      parameters: {
        type: "object",
        properties: {
          advances: {
            type: "array",
            items: {
              type: "object",
              properties: {
                amount_dollars: { type: "number", description: "One advance, in dollars." },
                date: { type: "string", description: "The day he took it (YYYY-MM-DD), if he said." },
              },
              required: ["amount_dollars"],
            },
          },
          note: { type: "string", description: "Optional note, in his words." },
        },
        required: ["advances"],
      },
      access: "write",
      validateArgs(args) {
        const p = parseArgs(args, todayEastern());
        if (!p.ok) return p;
        return { ok: true, args: { ...args } };
      },
      async verifyProposal(args) {
        const p = parseArgs(args, todayEastern());
        if (!p.ok) return p;
        const dated = p.advances.map((a) => `${formatMoney(a.amount_cents)} on ${formatCalendarDay(a.advance_date)}`).join(", ");
        return { ok: true, summary: `Record cash advance${p.advances.length === 1 ? "" : "s"}: ${dated}. ${await whereTheyLand(p.advances)}.` };
      },
      summarize: (args) => {
        const n = Array.isArray(args.advances) ? args.advances.length : 0;
        return `Record ${n} cash advance${n === 1 ? "" : "s"}`;
      },
      async run(args) {
        const p = parseArgs(args, todayEastern());
        if (!p.ok) throw new Error(p.error);
        const { error } = await client
          .from("cash_advances")
          .insert(p.advances.map((a) => ({ company_id: companyId, amount_cents: a.amount_cents, advance_date: a.advance_date, note: p.note })));
        if (error) throw new Error(`I couldn't save the advance${p.advances.length === 1 ? "" : "s"}: ${error.message}`);
        // The check it comes out of, AFTER the advances, from the same pay summary the app shows.
        const summary = await loadPaySummary(client, companyId);
        const lines: string[] = [];
        for (const w of groupAdvancesByWeek(p.advances, await fetchPayTerms(client, companyId))) {
          const check = summary.paydays.find((g) => g.periodStart <= w.start && w.end <= g.periodEnd);
          const when = w.payday ? formatCalendarDay(w.payday) : "that week's payday";
          lines.push(
            check
              ? `Your ${when} check (pay week ${formatCalendarDay(w.start)} to ${formatCalendarDay(w.end)}) now expects about ${formatMoney(check.netLowCents)} after ${formatMoney(check.advancesCents)} in advances.`
              : `It comes out of your ${when} check (pay week ${formatCalendarDay(w.start)} to ${formatCalendarDay(w.end)}); no finished loads in that week yet, so there's no expected amount to net it against.`,
          );
        }
        return `Saved ${p.advances.length} cash advance${p.advances.length === 1 ? "" : "s"} (Money → Advances). ${lines.join(" ")}`;
      },
    },
  ];
}
