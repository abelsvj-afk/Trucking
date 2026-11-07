"use client";

// Home's small pay preview: this week's projected pay across his loads, from
// his own pay terms (lib/pay-projection.ts). Says what it is counting - while
// his miles basis is unset it shows a range and says so, never a quiet guess.
// Gross at his stated rate; his settlement is the truth.

import Link from "next/link";
import { usePayProjection } from "@/lib/use-pay-projection";
import { describeTerms, formatCents, formatDay, formatRange } from "@/lib/pay-projection";
import { advancesForPeriod, netRange, sumAdvances } from "@/lib/cash-advances";

export default function PayPreviewCard() {
  const state = usePayProjection();
  if (state.status === "loading" || state.status === "error") return null;

  if (state.status === "no-terms") {
    return (
      <section aria-label="Projected pay" className="active-load">
        <h2>Projected pay</h2>
        <p className="row-sub">
          Add your pay terms and this shows what the week is worth as loads come in.{" "}
          <Link href="/more/settings">Add pay terms</Link>
        </p>
      </section>
    );
  }

  const { period, terms } = state;
  const weekAdvances = advancesForPeriod(state.advances, period.start, period.end);
  const advancesCents = sumAdvances(weekAdvances);
  const net = netRange(period.lowCents, period.highCents, advancesCents);
  return (
    <section aria-label="Projected pay" className="active-load">
      <h2>Projected pay this pay week</h2>
      {period.rows.length === 0 && advancesCents === 0 ? (
        <p className="row-sub">No booked loads this pay week yet.</p>
      ) : (
        <>
          <p className="active-load-route">
            <strong>{formatRange(period.lowCents, period.highCents)}</strong>
          </p>
          {advancesCents > 0 && (
            <p className="row-sub">
              − {formatCents(advancesCents)} in <Link href="/money/advances">cash advances</Link> already taken out of this pay
              {" · "}
              <strong>
                net you should get: {formatRange(net.lowCents, net.highCents)}
              </strong>
              {net.highCents < 0 ? " — more taken out than this week is expected to pay so far" : ""}
            </p>
          )}
          <p className="row-sub">
            {period.rows.length} load{period.rows.length === 1 ? "" : "s"} · {describeTerms(terms)}
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
      )}
      <p className="row-sub">
        Projection before fuel, taxes and deductions — your settlement is the final number.{" "}
        <Link href="/money/pay">Breakdown</Link>
      </p>
    </section>
  );
}
