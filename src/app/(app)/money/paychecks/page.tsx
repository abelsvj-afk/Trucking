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
import { paydayTitle, stillOwedWords } from "@/lib/payday-text";
import type { PaySummaryLoad } from "@/services/api/pay-summary";

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
      <PageHeader title="Paychecks" purpose="Your pay organised by payday: what you should get, what was taken as advances, what landed, and what is still owed — with the loads behind each." />
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
          {state.summary.totals.advancesCents > 0 && (
            <p role="status">
              <Link href="/money/advances">Cash advances</Link> taken out of these pay weeks: {formatCents(state.summary.totals.advancesCents)}.
              {state.summary.totals.unpaidCount > 0
                ? ` After those advances, the unpaid loads should net ${formatRange(state.summary.totals.unpaidNetLowCents, state.summary.totals.unpaidNetHighCents)}.`
                : ""}
            </p>
          )}
          <p role="note" className="row-sub">
            Expected pay uses the terms in force on each delivery date. &quot;Received&quot; is the pay line a settlement
            names for that load — record your settlements and this fills in. Your settlement is the final number.
          </p>
          {state.summary.paydays.length > 0 && (
            <section aria-label="By payday">
              <h2>By payday</h2>
              {state.summary.paydays.map((g) => (
                <article key={g.payday ?? g.periodStart} aria-label={paydayTitle(g)}>
                  <h3>
                    {paydayTitle(g)}
                    {g.overdue ? " — past due" : ""}
                  </h3>
                  <p className="row-sub">
                    Pay weeks {formatDay(g.periodStart)} to {formatDay(g.periodEnd)} · {g.loadCount} load{g.loadCount === 1 ? "" : "s"}
                    {g.statement ? ` · statement ${formatDay(g.statement)}` : ""}
                  </p>
                  <dl>
                    <div>
                      <dt>Expected total</dt>
                      <dd>
                        {formatRange(g.expectedLowCents, g.expectedHighCents)}
                        {g.unpricedCount > 0 ? ` (+${g.unpricedCount} load${g.unpricedCount === 1 ? "" : "s"} I can't price yet)` : ""}
                      </dd>
                    </div>
                    <div>
                      <dt>Advances taken</dt>
                      <dd>{g.advancesCents > 0 ? `− ${formatCents(g.advancesCents)}` : "none"}</dd>
                    </div>
                    <div>
                      <dt>Net expected</dt>
                      <dd>
                        <strong>{formatRange(g.netLowCents, g.netHighCents)}</strong>
                        {g.netHighCents < 0 ? " (more taken out than this payday is expected to pay)" : ""}
                      </dd>
                    </div>
                    <div>
                      <dt>Received so far</dt>
                      <dd>{formatCents(g.receivedCents)}</dd>
                    </div>
                    <div>
                      <dt>Still owed</dt>
                      <dd>
                        <strong>{stillOwedWords(g)}</strong>
                        {g.shortCount > 0 ? ` · SHORT ${formatCents(g.shortfallCents)} on ${g.shortCount} load${g.shortCount === 1 ? "" : "s"}` : ""}
                      </dd>
                    </div>
                  </dl>
                  {g.loads.length > 0 && (
                    <ul aria-label={`Loads in ${paydayTitle(g)}`}>
                      {g.loads.map((c) => (
                        <LoadRow key={c.loadId} c={c} />
                      ))}
                    </ul>
                  )}
                </article>
              ))}
            </section>
          )}
          {(() => {
            const inPaydays = new Set(state.summary.paydays.flatMap((g) => g.loads.map((l) => l.loadId)));
            const rest = state.summary.completed.filter((c) => !inPaydays.has(c.loadId));
            if (state.summary.completed.length === 0) return <p>No finished loads yet.</p>;
            if (rest.length === 0) return null;
            return (
              <section aria-label="Loads without a pay date">
                <h2>Finished loads with no pay date</h2>
                <ul>
                  {rest.map((c) => (
                    <LoadRow key={c.loadId} c={c} />
                  ))}
                </ul>
              </section>
            );
          })()}
        </>
      )}
    </div>
  );
}

function LoadRow({ c }: { c: PaySummaryLoad }) {
  return (
    <li>
      <span className="row-title">
        <Link href={`/loads/${c.loadId}`}>{c.origin} → {c.destination}</Link>
      </span>
      <span className="row-sub">
        {c.deliveryDate ?? "no delivery date"} · <strong>{c.line ? STATUS_WORDS[c.line.status] : "No terms"}</strong>
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
  );
}
