"use client";

// Home's ONE driver-pay section (owner order 2026-11-07). Home used to
// show pay twice - a "Projected pay" card (this pay week's projection)
// and a separate "Pay and hours" card (active load, finished-unpaid,
// advances) - which read as the same money explained two ways. This
// card tells the story once, in order: what the active load pays,
// what this pay week is worth (with this week's advances netted and
// the payday named), what finished loads are still unpaid, and the
// hours glance. Every figure comes from the two existing sources -
// the server pay summary (usePaySummary) and the pay projection
// (usePayProjection) - no pay math lives here. Honesty rule preserved:
// while the miles basis is unset the figures are ranges with the
// reason stated, never one confident number.

import Link from "next/link";
import { usePaySummary } from "@/lib/use-pay-summary";
import { usePayProjection } from "@/lib/use-pay-projection";
import { describeTerms, formatCents, formatDay, formatRange } from "@/lib/pay-projection";
import { advancesForPeriod, netRange, sumAdvances } from "@/lib/cash-advances";

const hm = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

export default function DriverPayHomeCard() {
  const summaryState = usePaySummary();
  const projectionState = usePayProjection();

  if (projectionState.status === "no-terms") {
    return (
      <section aria-label="Driver pay" className="active-load">
        <h2>Driver pay</h2>
        <p className="row-sub">
          Add your pay terms and this shows what the week is worth as loads come in.{" "}
          <Link href="/more/settings">Add pay terms</Link>
        </p>
      </section>
    );
  }

  const summary = summaryState.status === "ready" && summaryState.summary.hasTerms ? summaryState.summary : null;
  const projection = projectionState.status === "ready" ? projectionState : null;
  if (!summary && !projection) return null;

  const active = summary?.active ?? null;
  const totals = summary?.totals ?? null;
  const hos = summary?.hos ?? null;

  // Pay truth fail-safe, client half (ChatGPT audit 2026-11-07, owner
  // Option A 2026-11-07): a FAILED cash-advances read in the projection
  // is "unavailable", never zero. In that state no net figure drawn from
  // the projection is rendered anywhere in this card and the gap is
  // stated plainly; gross figures still show. (The server pay summary
  // fails visibly on its own advances error - see pay-summary - so a
  // ready summary's totals are real and stay as they were.)
  const advancesUnavailable = projection !== null && projection.advancesAvailable === false;

  const period = projection?.period ?? null;
  const weekAdvancesCents =
    projection && period && !advancesUnavailable
      ? sumAdvances(advancesForPeriod(projection.advances, period.start, period.end))
      : 0;
  const weekNet = period && !advancesUnavailable ? netRange(period.lowCents, period.highCents, weekAdvancesCents) : null;
  // Advances are netted in exactly one place in this story: against
  // this pay week's projection when this week has any. Advances taken
  // against other weeks' still-unpaid loads are shown netted against
  // those instead - never both, so no dollar reads as counted twice.
  const showUnpaidAdvances = !advancesUnavailable && weekAdvancesCents === 0 && totals !== null && totals.advancesCents > 0;

  const hasWeek = period !== null && (period.rows.length > 0 || weekAdvancesCents > 0);
  const nothing =
    !active &&
    !hasWeek &&
    (totals === null || (totals.unpaidCount === 0 && totals.shortCount === 0 && !showUnpaidAdvances)) &&
    !hos &&
    !advancesUnavailable;
  if (nothing && !period) return null;

  return (
    <section aria-label="Driver pay" className="active-load">
      <h2>Driver pay</h2>
      {active && (
        <p>
          <Link href={`/loads/${active.loadId}`}>Active load</Link>:{" "}
          {active.line?.expected && active.line.expected.lowCents !== null && active.line.expected.highCents !== null ? (
            <strong>{formatRange(active.line.expected.lowCents, active.line.expected.highCents)}</strong>
          ) : (
            "can't price yet (no mileage)"
          )}
        </p>
      )}
      {period &&
        (hasWeek ? (
          <>
            <p className="active-load-route">
              This pay week: <strong>{formatRange(period.lowCents, period.highCents)}</strong>
            </p>
            {weekAdvancesCents > 0 && weekNet && (
              <p className="row-sub">
                − {formatCents(weekAdvancesCents)} in <Link href="/money/advances">cash advances</Link> already taken
                out of this pay{" · "}
                <strong>net you should get: {formatRange(weekNet.lowCents, weekNet.highCents)}</strong>
                {weekNet.highCents < 0 ? " — more taken out than this week is expected to pay so far" : ""}
              </p>
            )}
            <p className="row-sub">
              {period.rows.length} load{period.rows.length === 1 ? "" : "s"} ·{" "}
              {projection ? describeTerms(projection.terms) : ""}
              {period.statement ? ` · statement ${formatDay(period.statement)}` : ""}
              {period.payday ? ` · payday ${formatDay(period.payday)}` : ""}
              {period.unavailableCount > 0 ? ` · ${period.unavailableCount} can't be projected yet` : ""}
            </p>
            {period.basisAssumed && (
              <p className="row-sub" role="note">
                Your miles basis isn&apos;t set, so this is a range (loaded miles only to all miles).{" "}
                <Link href="/more/settings">Set it</Link>
              </p>
            )}
          </>
        ) : (
          <p className="row-sub">No booked loads this pay week yet.</p>
        ))}
      {totals && (totals.unpaidCount > 0 || totals.shortCount > 0) && (
        <p>
          <Link href="/money/paychecks">Paychecks</Link>:{" "}
          {totals.unpaidCount > 0
            ? `${totals.unpaidCount} finished, unpaid (~${formatRange(totals.unpaidLowCents, totals.unpaidHighCents)})`
            : ""}
          {totals.unpaidCount > 0 && totals.shortCount > 0 ? " · " : ""}
          {totals.shortCount > 0 ? `${totals.shortCount} short ${formatCents(totals.shortfallCents)}` : ""}
        </p>
      )}
      {showUnpaidAdvances && totals && (
        <p>
          <Link href="/money/advances">Cash advances</Link>: {formatCents(totals.advancesCents)} already taken out of
          your pay
          {totals.unpaidCount > 0
            ? ` · unpaid loads should net ~${formatRange(totals.unpaidNetLowCents, totals.unpaidNetHighCents)}`
            : ""}
        </p>
      )}
      {advancesUnavailable && (
        <p className="row-sub" role="note">
          Cash advances couldn&apos;t load, so these pay figures don&apos;t take advances out — they may be
          incomplete.
        </p>
      )}
      {hos && (
        <p>
          <Link href="/fleet/hos">Hours</Link>: break due in {hm(hos.breakDueInMs)}
          {hos.cycleLeftMs !== null ? ` · ${hm(hos.cycleLeftMs)} left in your ${hos.cycleLabel ?? "cycle"}` : ""}
        </p>
      )}
      <p className="row-sub">
        Gross at your terms; projection before fuel, taxes and deductions — your settlement is the final number.{" "}
        <Link href="/money/pay">Breakdown</Link>
      </p>
    </section>
  );
}
