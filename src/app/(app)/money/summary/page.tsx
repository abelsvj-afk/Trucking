"use client";

// Task 3.11 (TASKS.md). The full /financial-summary view with a
// date-range picker, per docs/design/ui-ux.md - not just the Home
// snapshot, which is always the current month.
//
// Reliability Unit C (design C.2-C.4, ruling D-01): the labels are
// the truth the figures carry. Revenue is operational load revenue
// recognized on delivery - its label renders from the API's
// revenueConvention field, never as cash received. Pipeline (booked,
// not yet delivered) is shown separately and never added in.
// Completed loads missing a delivery date are a named exception with
// a link, not a silent exclusion. Every total links to the rows
// behind it (F-010). The one-time restatement notice below carries
// the design's exact wording (C.2) and shows until dismissed once.

import { useState, useSyncExternalStore, type FormEvent } from "react";
import Link from "next/link";
import { useFinancialSummary } from "@/lib/use-financial-summary";
import { ListLoading, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import PageHeader from "@/components/PageHeader";
import { revenueConventionLabel, type FinancialSummary } from "@/types/financial-summary";

const RESTATEMENT_NOTICE_KEY = "unit-c-restatement-notice-dismissed";
const RESTATEMENT_NOTICE_EVENT = "unit-c-restatement-notice-changed";

function subscribeRestatementNotice(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(RESTATEMENT_NOTICE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(RESTATEMENT_NOTICE_EVENT, onChange);
  };
}
export const RESTATEMENT_NOTICE_TEXT =
  "Past months' operational revenue was restated to count loads when delivered. This changes how this app reports its own figures; it does not change any cash you received or any tax record.";

function formatDollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function detailHref(
  component: "revenue" | "expenses" | "fuel" | "maintenance",
  summary: FinancialSummary,
) {
  const qs = new URLSearchParams({
    component,
    from: summary.range.from,
    to: summary.range.to,
  });
  return `/money/summary/detail?${qs.toString()}`;
}

export default function FinancialSummaryPage() {
  usePageTitle("Financial summary");
  // Undefined until the owner picks a range - the hook then omits params,
  // so the server applies its own current viewer-local month default and
  // the returned range echoes back exactly what was used.
  const [range, setRange] = useState<{ from: string; to: string } | undefined>(undefined);
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const { state, retry } = useFinancialSummary(range);
  // The dismissal flag lives in localStorage (an external system);
  // useSyncExternalStore is the sanctioned bridge for it. The server
  // snapshot is "dismissed" so the notice never flashes before the
  // client's stored answer is read.
  const noticeDismissed = useSyncExternalStore(
    subscribeRestatementNotice,
    () => {
      try {
        return window.localStorage.getItem(RESTATEMENT_NOTICE_KEY) === "1";
      } catch {
        return false;
      }
    },
    () => true,
  );

  function dismissNotice() {
    try {
      window.localStorage.setItem(RESTATEMENT_NOTICE_KEY, "1");
    } catch {
      // Storage unavailable: the notice simply returns next visit.
    }
    window.dispatchEvent(new Event(RESTATEMENT_NOTICE_EVENT));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (fromInput && toInput) setRange({ from: fromInput, to: toInput });
  }

  const summary = state.status === "loaded" ? state.summary : null;
  const missingDelivery = summary?.exceptions.completedMissingDeliveryDate;

  return (
    <div>
      <PageHeader
        title="Financial summary"
        purpose="Revenue against every cost, for any stretch of days — the honest answer to how the business is doing."
      />

      {!noticeDismissed && (
        <section aria-label="Restatement notice">
          <p>{RESTATEMENT_NOTICE_TEXT}</p>
          <button type="button" onClick={dismissNotice}>
            Got it
          </button>
        </section>
      )}

      <form onSubmit={handleSubmit}>
        <label htmlFor="from">From</label>
        <input id="from" type="date" value={fromInput} onChange={(e) => setFromInput(e.target.value)} />

        <label htmlFor="to">To</label>
        <input id="to" type="date" value={toInput} onChange={(e) => setToInput(e.target.value)} />

        <button type="submit">View range</button>
      </form>

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {summary && (
        <>
          <dl>
            <dt>Range</dt>
            <dd>
              {summary.range.from} – {summary.range.to} ({summary.timeZone})
            </dd>
            <dt>{revenueConventionLabel(summary.revenueConvention)}</dt>
            <dd>
              <Link href={detailHref("revenue", summary)}>
                {formatDollars(summary.revenue_cents)}
              </Link>
            </dd>
            <dt>Expenses</dt>
            <dd>
              <Link href={detailHref("expenses", summary)}>
                {formatDollars(summary.expenses_cents)}
              </Link>
            </dd>
            <dt>Fuel</dt>
            <dd>
              <Link href={detailHref("fuel", summary)}>
                {formatDollars(summary.fuel_cents)}
              </Link>
            </dd>
            <dt>Maintenance</dt>
            <dd>
              <Link href={detailHref("maintenance", summary)}>
                {formatDollars(summary.maintenance_cents)}
              </Link>
            </dd>
            <dt>Operating result</dt>
            <dd>{formatDollars(summary.measures.periodOperatingResult)}</dd>
            <dt>Contribution margin — loads delivered in this period</dt>
            <dd>{formatDollars(summary.measures.aggregateContributionMargin)}</dd>
            {summary.measures.fuelNotAssigned !== undefined && (
              <>
                <dt>Fuel not assigned to a load</dt>
                <dd>{formatDollars(summary.measures.fuelNotAssigned)}</dd>
              </>
            )}
            <dt>Pipeline — booked, not yet delivered</dt>
            <dd>
              {formatDollars(summary.pipeline.total_cents)} ({summary.pipeline.row_count}{" "}
              {summary.pipeline.row_count === 1 ? "load" : "loads"})
            </dd>
          </dl>

          {summary.estimatedPay && (summary.estimatedPay.loadCount > 0 || summary.estimatedPay.unvaluedCount > 0) && (
            <p role="note">
              {summary.estimatedPay.loadCount > 0 && (
                <>
                  {summary.estimatedPay.loadCount} delivered load{summary.estimatedPay.loadCount === 1 ? " has" : "s have"} no rate recorded, so {summary.estimatedPay.loadCount === 1 ? "it counts" : "they count"} as $0 in the revenue above.
                  At your pay terms times the miles, {summary.estimatedPay.loadCount === 1 ? "it" : "they"} would be about{" "}
                  <strong>{formatDollars(summary.estimatedPay.cents)}</strong> — an estimate, shown separately and not added to revenue.{" "}
                </>
              )}
              {summary.estimatedPay.unvaluedCount > 0 &&
                `${summary.estimatedPay.unvaluedCount} more can't be valued yet (no mileage or pay terms).`}
            </p>
          )}

          {summary.pipeline.loadsWithoutRateCount > 0 && (
            <p>
              {summary.pipeline.loadsWithoutRateCount}{" "}
              {summary.pipeline.loadsWithoutRateCount === 1 ? "load" : "loads"} without a rate —
              counted as $0 in the pipeline.
            </p>
          )}

          {missingDelivery && missingDelivery.count > 0 && (
            <p role="alert">
              Completed loads missing a delivery date: {missingDelivery.count} — excluded from
              revenue. <Link href="/loads">Review those loads</Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}
