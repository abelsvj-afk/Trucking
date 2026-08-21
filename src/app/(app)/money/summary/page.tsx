"use client";

// Task 3.11 (TASKS.md). The full /financial-summary view with a
// date-range picker, per docs/design/ui-ux.md - not just the Home
// snapshot, which is always the current month.

import { useState, type FormEvent } from "react";
import { useFinancialSummary } from "@/lib/use-financial-summary";
import { ListLoading, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";

function formatDollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function FinancialSummaryPage() {
  usePageTitle("Financial summary");
  // Undefined until the owner picks a range - the hook then omits params,
  // so the server applies its own current-calendar-month default and the
  // returned range echoes back exactly what was used.
  const [range, setRange] = useState<{ from: string; to: string } | undefined>(undefined);
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const { state, retry } = useFinancialSummary(range);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (fromInput && toInput) setRange({ from: fromInput, to: toInput });
  }

  return (
    <div>
      <h1>Financial summary</h1>

      <form onSubmit={handleSubmit}>
        <label htmlFor="from">From</label>
        <input id="from" type="date" value={fromInput} onChange={(e) => setFromInput(e.target.value)} />

        <label htmlFor="to">To</label>
        <input id="to" type="date" value={toInput} onChange={(e) => setToInput(e.target.value)} />

        <button type="submit">View range</button>
      </form>

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && (
        <dl>
          <dt>Range</dt>
          <dd>
            {state.summary.range.from} – {state.summary.range.to}
          </dd>
          <dt>Revenue</dt>
          <dd>{formatDollars(state.summary.revenue_cents)}</dd>
          <dt>Expenses</dt>
          <dd>{formatDollars(state.summary.expenses_cents)}</dd>
          <dt>Fuel</dt>
          <dd>{formatDollars(state.summary.fuel_cents)}</dd>
          <dt>Maintenance</dt>
          <dd>{formatDollars(state.summary.maintenance_cents)}</dd>
          <dt>Net</dt>
          <dd>{formatDollars(state.summary.net_cents)}</dd>
        </dl>
      )}
    </div>
  );
}
