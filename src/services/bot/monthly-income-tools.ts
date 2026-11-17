// "How much will I make this month / am I at my goal / how much more before I go home"
// (docs/design/monthly-income-goal.md). Read-only; the same loader as Money → This month.

import type { AgentTool } from "@/services/ai/agent-loop";
import { loadMonthIncome } from "@/services/api/monthly-income";
import { formatMoney } from "@/lib/money-format";
import type { BotBrainStore } from "./store";

const range = (lo: number, hi: number) => (lo === hi ? formatMoney(lo) : `${formatMoney(lo)} to ${formatMoney(hi)}`);

export function buildMonthlyIncomeTools(store: BotBrainStore): AgentTool[] {
  return [
    {
      name: "monthly_income",
      description:
        "His projected pay for a calendar month from booked + finished loads (by delivery date), his monthly goal, how much more he needs, and the load that reaches the goal ('how much will I make this month', 'am I at my goal', 'how much more before I can go home').",
      parameters: { type: "object", properties: { month: { type: "string", description: "YYYY-MM; omit for this month." } } },
      access: "read",
      async run(args) {
        const m = await loadMonthIncome(store.client, store.companyId, typeof args.month === "string" ? args.month : undefined);
        const lines = [
          `Month ${m.month}: projected pay ${range(m.totalLowCents, m.totalHighCents)} (earned ${range(m.earnedLowCents, m.earnedHighCents)}, booked ahead ${range(m.bookedLowCents, m.bookedHighCents)}).`,
          m.unpricedCount > 0 ? `${m.unpricedCount} load(s) can't be priced yet and are NOT counted.` : "",
          m.goalCents
            ? m.goalLoad
              ? `Goal ${formatMoney(m.goalCents)}: reached after ${m.goalLoad.label} (delivery ${m.goalLoad.deliveryDate}).`
              : `Goal ${formatMoney(m.goalCents)}: ${formatMoney(m.stillNeededCents ?? 0)} more needed beyond the loads booked so far.`
            : m.goalReady
              ? "He has no monthly goal set - he can set one in the app: Money → This month."
              : "Monthly goals aren't switched on yet (database update pending).",
          ...m.rows.map((r) => `- ${r.label}, delivery ${r.deliveryDate}: ${r.lowCents === null ? `can't price (${r.note})` : range(r.lowCents, r.highCents ?? r.lowCents)}; after it ${range(r.runningLowCents, r.runningHighCents)}${r.reachesGoal ? " [GOAL REACHED]" : ""}`),
        ];
        return lines.filter(Boolean).join("\n");
      },
    },
  ];
}
