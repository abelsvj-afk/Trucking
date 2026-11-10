"use client";

// Money tab index. Per docs/design/ui-ux.md, Money's own sections
// (Expenses/Fuel/Summary) are reached via links here - added as each
// lands (tasks 3.7-3.8, 3.11), not built ahead of what exists.
//
// UI/UX upgrade: entries carry their one-line purpose, and the tab
// gets its Ask-the-assistant entry point.
//
// Phase 4 (spec §2.4): rows render through the design system's
// HubRow, and two rows carry inline figures so "check" often ends at
// the hub — Expenses shows this week's (Sun–Sat) total from the
// expenses list, Paychecks shows the last definite paycheck figure
// from the pay summary. A figure that can't load shows NO number —
// never a fake one. (Client component now, so the title comes from
// usePageTitle like every other data-fetching screen.)
import PageHeader from "@/components/PageHeader";
import AskAssistant from "@/components/AskAssistant";
import HubRow from "@/components/HubRow";
import Reveal from "@/components/Reveal";
import { useApiList } from "@/lib/use-api-list";
import { usePageTitle } from "@/lib/use-page-title";
import { usePaySummary } from "@/lib/use-pay-summary";
import { lastDefinitePaycheckCents, thisWeekExpensesCents } from "@/lib/money-hub";
import { formatCents } from "@/lib/pay-projection";
import type { Expense } from "@/types/entities";
import type { ReactNode } from "react";

const SECTIONS: { href: string; label: string; desc: string }[] = [
  { href: "/money/expenses", label: "Expenses", desc: "What the business spends — insurance, permits, repairs, the rest." },
  { href: "/money/fuel-purchases", label: "Fuel purchases", desc: "Every fuel stop: gallons, price, and where." },
  { href: "/money/pay", label: "Driver pay", desc: "What this week's loads are worth at your pay terms — updating as loads come in." },
  { href: "/money/paychecks", label: "Paychecks", desc: "Finished loads: what you should have been paid vs. what landed — shortfalls flagged." },
  { href: "/money/advances", label: "Cash advances", desc: "Money taken out of a pay period before payday — record it here and every pay figure shows the net." },
  { href: "/money/invoices", label: "Invoices", desc: "What brokers owe you, and how late — aged against the due date." },
  { href: "/money/summary", label: "Summary", desc: "Revenue, costs, and what's actually left — by period." },
  { href: "/money/truck-fund", label: "Truck Fund", desc: "Saving toward your own truck — the fund log, target bands, and the business-credit ladder." },
];

export default function MoneyPage() {
  usePageTitle("Money");
  const expenses = useApiList<Expense>("expenses", { limit: "200" });
  const paySummary = usePaySummary();

  const weekTotal =
    expenses.state.status === "loaded" ? thisWeekExpensesCents(expenses.state.result.data) : null;
  const lastPaycheck =
    paySummary.status === "ready" ? lastDefinitePaycheckCents(paySummary.summary) : null;

  function descFor(section: (typeof SECTIONS)[number]): ReactNode {
    if (section.href === "/money/expenses" && weekTotal !== null) {
      return (
        <>
          {section.desc} <strong>This week: {formatCents(weekTotal)}</strong>
        </>
      );
    }
    if (section.href === "/money/paychecks" && lastPaycheck !== null) {
      return (
        <>
          {section.desc} <strong>Last definite check: {formatCents(lastPaycheck)}</strong>
        </>
      );
    }
    return section.desc;
  }

  return (
    <div>
      <PageHeader title="Money" purpose="What came in, what went out, and what's left — the numbers the business runs on." />
      <ul>
        {SECTIONS.map((section, i) => (
          <Reveal as="li" key={section.href} index={i}>
            <HubRow href={section.href} label={section.label} desc={descFor(section)} />
          </Reveal>
        ))}
      </ul>

      <AskAssistant
        heading="Ask about the money in plain words — Abel answers from these same records:"
        prompts={["What did I earn this week?", "What have I spent on fuel this month?", "Which load paid the best per mile?"]}
      />
    </div>
  );
}
