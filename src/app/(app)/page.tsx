"use client";

// Home dashboard, per docs/design/ui-ux.md. Task 3.11: the financial
// summary card for the current month, pulled from /financial-summary with
// no params (server defaults to the current calendar month). "Recent
// activity" and quick-add buttons aren't part of 3.11's acceptance
// criteria and stay for a later task rather than being built ahead of it.

import Link from "next/link";
import { useFinancialSummary } from "@/lib/use-financial-summary";
import { ListLoading, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";

function formatDollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function HomePage() {
  usePageTitle("Home");
  const { state, retry } = useFinancialSummary();

  return (
    <div>
      <h1>Trucking OS</h1>

      <section aria-label="This month's financial summary">
        <h2>This month</h2>
        {state.status === "loading" && <ListLoading />}
        {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
        {state.status === "loaded" && (
          <dl>
            <dt>Revenue</dt>
            <dd>{formatDollars(state.summary.revenue_cents)}</dd>
            <dt>Expenses</dt>
            <dd>
              {formatDollars(
                state.summary.expenses_cents +
                  state.summary.fuel_cents +
                  state.summary.maintenance_cents,
              )}
            </dd>
            <dt>Net</dt>
            <dd>{formatDollars(state.summary.net_cents)}</dd>
          </dl>
        )}
        <Link href="/money/summary">View full summary</Link>
      </section>
    </div>
  );
}
