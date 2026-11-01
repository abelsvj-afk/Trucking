// Money tab index. Per docs/design/ui-ux.md, Money's own sections
// (Expenses/Fuel/Summary) are reached via links here - added as each
// lands (tasks 3.7-3.8, 3.11), not built ahead of what exists.
//
// UI/UX upgrade: entries carry their one-line purpose, and the tab
// gets its Ask-the-assistant entry point.
//
// A Server Component (no "use client"), so it uses Next's own `metadata`
// export for a distinct <title> (WCAG 2.4.2) rather than the
// usePageTitle() client hook every data-fetching screen uses instead.
import Link from "next/link";
import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";
import AskAssistant from "@/components/AskAssistant";

export const metadata: Metadata = { title: "Money — Trucking OS" };

const SECTIONS: { href: string; label: string; desc: string }[] = [
  { href: "/money/expenses", label: "Expenses", desc: "What the business spends — insurance, permits, repairs, the rest." },
  { href: "/money/fuel-purchases", label: "Fuel purchases", desc: "Every fuel stop: gallons, price, and where." },
  { href: "/money/summary", label: "Summary", desc: "Revenue, costs, and what's actually left — by period." },
  { href: "/money/truck-fund", label: "Truck Fund", desc: "Saving toward your own truck — the fund log, target bands, and the business-credit ladder." },
];

export default function MoneyPage() {
  return (
    <div>
      <PageHeader title="Money" purpose="What came in, what went out, and what's left — the numbers the business runs on." />
      <ul>
        {SECTIONS.map((section) => (
          <li key={section.href}>
            <Link href={section.href} className="hub-link">
              {section.label}
            </Link>
            <span className="hub-desc">{section.desc}</span>
          </li>
        ))}
      </ul>

      <AskAssistant
        heading="Ask about the money in plain words — King answers from these same records:"
        prompts={["What did I earn this week?", "What have I spent on fuel this month?", "Which load paid the best per mile?"]}
      />
    </div>
  );
}
