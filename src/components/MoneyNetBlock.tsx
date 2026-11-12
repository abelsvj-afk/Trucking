"use client";

// Money opens on the net (docs/design/money-hub-net-first.md, owner-approved 2026-11-12).
// Two blocks above the Money sections: what THIS pay week is expected to net, and up to six finished pay
// weeks. Presentational: the net comes from payWeekNet() - the same calculation Home's pay card reads - and
// the finished weeks from the server pay summary that Paychecks and Abel read. No pay math lives here.
//
// Honesty rules (requirements, not styling):
//  - "expected" stays on screen; a settlement is the final number;
//  - a range is shown as a range, never as one number;
//  - when advances or deductions failed to load, NO net is shown and the reason is stated;
//  - a finished week says whether it was paid, came up short, or is not paid yet.

import Link from "next/link";
import { formatDay } from "@/lib/pay-projection";
import { formatMoney } from "@/lib/money-format";
import { formatMoneyRange, payWeekNet, recentPayWeeks, type PayWeekStatus } from "@/lib/money-hub";
import type { PayProjectionState } from "@/lib/use-pay-projection";
import type { PaySummaryState } from "@/lib/use-pay-summary";

const STATUS_WORDS: Record<PayWeekStatus, string> = {
  paid: "paid",
  short: "came up short",
  unpaid: "not paid yet",
};

export default function MoneyNetBlock({
  projection,
  summary,
}: {
  projection: PayProjectionState;
  summary: PaySummaryState;
}) {
  return (
    <>
      <ThisPayWeek projection={projection} />
      <RecentWeeks summary={summary} currentStart={projection.status === "ready" ? projection.period.start : null} />
    </>
  );
}

function ThisPayWeek({ projection }: { projection: PayProjectionState }) {
  if (projection.status === "loading") {
    return (
      <section aria-label="This pay week" className="money-net">
        <p className="money-net-label">This pay week</p>
        <p className="row-sub" role="status">Loading your pay week…</p>
      </section>
    );
  }
  if (projection.status === "error") {
    return (
      <section aria-label="This pay week" className="money-net">
        <p className="money-net-label">This pay week</p>
        <p className="row-sub" role="note">
          Your pay week couldn&apos;t load, so no figure is shown. <Link href="/money/pay">Open Driver pay</Link> to try again.
        </p>
      </section>
    );
  }
  if (projection.status === "no-terms") {
    return (
      <section aria-label="This pay week" className="money-net">
        <p className="money-net-label">This pay week</p>
        <p className="row-sub">
          Add your pay terms and this shows what the week is expected to net. <Link href="/more/settings/pay">Add pay terms</Link>
        </p>
      </section>
    );
  }

  const { period } = projection;
  const week = payWeekNet(projection);
  const isRange = period.lowCents !== period.highCents;

  return (
    <section aria-label="This pay week" className="money-net">
      <p className="money-net-label">
        This pay week · {formatDay(period.start)} to {formatDay(period.end)}
      </p>
      {!week.hasWeek ? (
        <p className="row-sub">No booked loads this pay week yet.</p>
      ) : week.net ? (
        <>
          <p className="money-net-figure">
            <Link href="/money/pay">{formatMoneyRange(week.net.lowCents, week.net.highCents)}</Link>
          </p>
          <p className="money-net-caption">
            Expected net{week.net.highCents < 0 ? " — more has been taken out than this week is expected to pay so far" : ""}
          </p>
          <p className="row-sub">
            {formatMoneyRange(period.lowCents, period.highCents)} expected
            {week.advancesCents > 0 ? ` − ${formatMoney(week.advancesCents)} cash advances` : ""}
            {week.deductionsCents > 0 ? ` − ${formatMoney(week.deductionsCents)} pay deductions` : ""}
            {week.outCents === 0 ? " · nothing taken out" : ""}
          </p>
        </>
      ) : (
        <>
          <p className="money-net-figure money-net-figure-gross">
            <Link href="/money/pay">{formatMoneyRange(period.lowCents, period.highCents)}</Link>
          </p>
          <p className="money-net-caption">Expected before anything is taken out</p>
          <p className="row-sub" role="note">
            {week.advancesUnavailable && week.deductionsUnavailable
              ? "Cash advances and pay deductions couldn't load, so no net is shown."
              : week.advancesUnavailable
                ? "Cash advances couldn't load, so no net is shown."
                : "Pay deductions couldn't load, so no net is shown."}
          </p>
        </>
      )}
      {week.hasWeek && (
        <p className="row-sub">
          {period.rows.length} load{period.rows.length === 1 ? "" : "s"}
          {period.payday ? ` · payday ${formatDay(period.payday)}` : " · payday not set"}
          {period.statement ? ` · statement ${formatDay(period.statement)}` : ""}
          {period.unavailableCount > 0 ? ` · ${period.unavailableCount} can't be projected yet` : ""}
        </p>
      )}
      {week.hasWeek && (isRange || period.basisAssumed) && (
        <p className="row-sub" role="note">
          This is a range because your miles basis isn&apos;t set (loaded miles only to all miles).{" "}
          <Link href="/more/settings/pay">Set it</Link>
        </p>
      )}
      <p className="row-sub">A projection at your pay terms, before fuel and taxes. Your settlement is the final number.</p>
    </section>
  );
}

function RecentWeeks({ summary, currentStart }: { summary: PaySummaryState; currentStart: string | null }) {
  if (summary.status === "loading") return null;
  if (summary.status === "error") {
    return (
      <section aria-label="Recent pay weeks" className="money-weeks">
        <h2>Recent pay weeks</h2>
        <p className="row-sub" role="note">Finished pay weeks couldn&apos;t load, so none are shown.</p>
      </section>
    );
  }
  if (!summary.summary.hasTerms) return null;
  const weeks = recentPayWeeks(summary.summary, currentStart);
  if (weeks.length === 0) return null;

  return (
    <section aria-label="Recent pay weeks" className="money-weeks">
      <h2>Recent pay weeks</h2>
      <ol>
        {weeks.map((week) => (
          <li key={week.key} className={`money-week money-week-${week.status}`}>
            <Link href="/money/paychecks">
              <span className="money-week-head">
                <span>{week.payday ? `Payday ${formatDay(week.payday)}` : `Week of ${formatDay(week.periodStart)}`}</span>
                <strong>{formatMoneyRange(week.expectedLowCents, week.expectedHighCents)}</strong>
              </span>
              <span className="money-week-bar" aria-hidden="true">
                <span style={{ width: `${Math.round(week.share * 100)}%` }} />
              </span>
              <span className="row-sub">
                expected · {week.loadCount} load{week.loadCount === 1 ? "" : "s"} · {STATUS_WORDS[week.status]}
                {week.receivedCents > 0 ? ` · ${formatMoney(week.receivedCents)} on statements so far` : ""}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
