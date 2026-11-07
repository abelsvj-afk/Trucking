"use client";

// Money -> Paychecks: every finished load, what he should have been paid at the
// terms in force on its delivery date, what actually landed (settlement pay
// lines naming the load), and which are short or still unpaid. Gross at his
// stated rate - his settlement is the final number; nothing here is a claim
// against anyone, it is a prompt to check.

import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import { usePaySummary } from "@/lib/use-pay-summary";
import { formatCents, formatDay, formatRange } from "@/lib/pay-projection";
import type { PaycheckStatus } from "@/lib/paycheck";

const STATUS_WORDS: Record<PaycheckStatus, string> = {
  paid: "Paid",
  short: "SHORT",
  over: "Paid more than expected",
  unpaid: "Not paid yet",
  unknown: "Can't check (no mileage)",
};

export default function PaychecksPage() {
  usePageTitle("Paychecks");
  const state = usePaySummary();

  return (
    <div>
      <PageHeader title="Paychecks" purpose="Finished loads: what you should have been paid vs. what landed." />
      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message="Couldn't load your paycheck check." onRetry={() => window.location.reload()} />}
      {state.status === "ready" && !state.summary.hasTerms && (
        <p>
          No pay terms yet, so nothing can be checked. <Link href="/more/settings">Add them in Settings → Pay terms</Link>.
        </p>
      )}
      {state.status === "ready" && state.summary.hasTerms && (
        <>
          <p role="status">
            {state.summary.totals.unpaidCount > 0
              ? `${state.summary.totals.unpaidCount} finished load${state.summary.totals.unpaidCount === 1 ? "" : "s"} not paid yet — about ${formatRange(state.summary.totals.unpaidLowCents, state.summary.totals.unpaidHighCents)} expected.`
              : "No finished loads waiting on pay."}{" "}
            {state.summary.totals.shortCount > 0
              ? `${state.summary.totals.shortCount} paid short by ${formatCents(state.summary.totals.shortfallCents)} in all.`
              : ""}
          </p>
          <p role="note" className="row-sub">
            Expected pay uses the terms in force on each delivery date. &quot;Received&quot; is the pay line a settlement
            names for that load — record your settlements and this fills in. Your settlement is the final number.
          </p>
          {state.summary.weeks.length > 0 && (
            <section aria-label="By pay week">
              <h2>By pay week</h2>
              <ul>
                {state.summary.weeks.map((w) => (
                  <li key={w.start}>
                    <span className="row-title">
                      {formatDay(w.start)} to {formatDay(w.end)} · {w.loadCount} load{w.loadCount === 1 ? "" : "s"}
                    </span>
                    <span className="row-sub">
                      Statement {w.statement ? formatDay(w.statement) : "day not set"} · paid {w.payday ? formatDay(w.payday) : "day not set"}
                    </span>
                    <span className="row-sub">
                      Should be {formatRange(w.expectedLowCents, w.expectedHighCents)}
                      {w.unpricedCount > 0 ? ` (+${w.unpricedCount} load${w.unpricedCount === 1 ? "" : "s"} I can't price yet)` : ""} · statements name{" "}
                      {formatCents(w.receivedCents)}
                      {w.shortCount > 0 ? ` · SHORT ${formatCents(w.shortfallCents)} on ${w.shortCount} load${w.shortCount === 1 ? "" : "s"}` : ""}
                      {w.unpaidCount > 0 ? ` · ${w.unpaidCount} not on a statement yet` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {state.summary.completed.length === 0 && <p>No finished loads yet.</p>}
          <ul>
            {state.summary.completed.map((c) => (
              <li key={c.loadId}>
                <span className="row-title">
                  <Link href={`/loads/${c.loadId}`}>{c.origin} → {c.destination}</Link>
                </span>
                <span className="row-sub">
                  {c.deliveryDate ?? "no delivery date"} ·{" "}
                  <strong>{c.line ? STATUS_WORDS[c.line.status] : "No terms"}</strong>
                  {c.line?.expected.lowCents != null && c.line.expected.highCents != null
                    ? ` · expected ${formatRange(c.line.expected.lowCents, c.line.expected.highCents)}`
                    : ""}
                  {c.line?.receivedCents != null ? ` · received ${formatCents(c.line.receivedCents)}` : ""}
                  {c.line && c.line.status === "short" ? ` · short ${formatCents(c.line.shortfallCents)}` : ""}
                </span>
                {c.line && !c.line.termsUsed.inForce && (
                  <span className="row-sub" role="note">
                    No pay terms covered this date, so the nearest ({c.line.termsUsed.employer_name}) were used.
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
