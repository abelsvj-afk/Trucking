// "I got paid $1,234.56" by talking to Abel (docs/design/confirm-paycheck.md, owner 2026-11-16). A write like any
// other: proposed, named back (which paycheck, what amount), done only on his yes. The arithmetic is
// services/api/paycheck-confirmations.ts - the same one the Paychecks page uses.

import type { AgentTool } from "@/services/ai/agent-loop";
import { loadPaySummary } from "@/services/api/pay-summary";
import { confirmPaycheck, type ConfirmedPayday } from "@/services/api/paycheck-confirmations";
import { formatMoney } from "@/lib/money-format";
import { todayEastern } from "@/lib/eastern-date";
import { formatCalendarDay } from "@/lib/time";
import type { BotBrainStore } from "./store";

type Args = { payday?: string; amount_dollars: number };

function parseArgs(args: Record<string, unknown>): { ok: true; args: Args } | { ok: false; error: string } {
  const amount = typeof args.amount_dollars === "number" ? args.amount_dollars : Number.parseFloat(String(args.amount_dollars ?? "").replace(/[$,]/g, ""));
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) return { ok: false, error: "amount_dollars must be what hit his bank, in dollars" };
  const payday = typeof args.payday === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.payday) ? args.payday : undefined;
  return { ok: true, args: { amount_dollars: Math.round(amount * 100) / 100, ...(payday ? { payday } : {}) } };
}

/** The paycheck he means: the named payday, else the most recent one that is due (payday today or earlier) and not confirmed. */
export function pickPaycheck(paydays: ConfirmedPayday[], payday: string | undefined, today: string): ConfirmedPayday | null {
  const withLoads = paydays.filter((g) => g.loadCount > 0);
  if (payday) return withLoads.find((g) => g.payday === payday || (g.periodStart <= payday && payday <= g.periodEnd)) ?? null;
  const due = withLoads
    .filter((g) => !g.confirmation && (g.payday === null || g.payday <= today))
    .sort((a, b) => (b.payday ?? b.periodEnd).localeCompare(a.payday ?? a.periodEnd));
  return due[0] ?? null;
}

const describe = (g: ConfirmedPayday) =>
  `${g.payday ? `the ${formatCalendarDay(g.payday)} paycheck` : "the paycheck"} (pay week ${formatCalendarDay(g.periodStart)} to ${formatCalendarDay(g.periodEnd)}, ${g.loadCount} load${g.loadCount === 1 ? "" : "s"})`;

export function buildPaycheckTools(store: BotBrainStore): AgentTool[] {
  const find = async (a: Args) => pickPaycheck((await loadPaySummary(store.client, store.companyId)).paydays, a.payday, todayEastern());
  return [
    {
      name: "confirm_paycheck",
      description:
        "He says a paycheck landed ('I got paid', 'my check came in, $1,234.56'). Records what hit his bank for one whole paycheck. " +
        "NEVER for a cash advance / bag advance / draw (money taken out against his pay) - that is record_cash_advance. " +
        "Pass amount_dollars (ask him if he didn't say it) and payday (YYYY-MM-DD) only if he named which one - otherwise the latest paycheck that is due is used. " +
        "A statement photo goes through extract_settlement instead.",
      parameters: {
        type: "object",
        properties: {
          amount_dollars: { type: "number", description: "What hit his bank, in dollars." },
          payday: { type: "string", description: "The payday he means (YYYY-MM-DD), if he named one." },
        },
        required: ["amount_dollars"],
      },
      access: "write",
      validateArgs: parseArgs,
      async verifyProposal(args) {
        const p = parseArgs(args);
        if (!p.ok) return p;
        const g = await find(p.args);
        if (!g) return { ok: false as const, error: "no paycheck with finished loads matches - ask him which payday he means" };
        const cents = Math.round(p.args.amount_dollars * 100);
        const vs =
          cents >= g.netLowCents
            ? "that covers the expected take-home"
            : `that is ${formatMoney(g.netLowCents - cents)} under the expected take-home of ${formatMoney(g.netLowCents)}`;
        return { ok: true as const, summary: `Mark ${describe(g)} as paid: ${formatMoney(cents)} hit your bank (${vs})` };
      },
      summarize: (args) => `Mark a paycheck as paid: ${formatMoney(Math.round(Number(args.amount_dollars ?? 0) * 100))}`,
      async run(args) {
        const p = parseArgs(args);
        if (!p.ok) throw new Error(p.error);
        const g = await find(p.args);
        if (!g) throw new Error("There is no paycheck with finished loads that matches.");
        const cents = Math.round(p.args.amount_dollars * 100);
        await confirmPaycheck(store.client, store.companyId, {
          periodStart: g.periodStart,
          periodEnd: g.periodEnd,
          payday: g.payday,
          receivedCents: cents,
          source: "abel",
        });
        const short = Math.max(0, g.netLowCents - cents);
        return `Marked ${describe(g)} as paid: ${formatMoney(cents)}.${short > 0 ? ` It came in ${formatMoney(short)} under the expected take-home - worth asking your carrier about.` : ""} You can undo it on Money → Paychecks.`;
      },
    },
  ];
}
