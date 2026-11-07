"use client";

// Home's compact pay-and-hours card (owner order item 4): expected pay on the
// active load, finished-but-unpaid total, break-due and cycle remaining.
// Consumes the server summary; every line taps through to where it lives.

import Link from "next/link";
import { usePaySummary } from "@/lib/use-pay-summary";
import { formatCents, formatRange } from "@/lib/pay-projection";

const hm = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

export default function PaycheckHomeCard() {
  const state = usePaySummary();
  if (state.status !== "ready" || !state.summary.hasTerms) return null;
  const { active, totals, hos } = state.summary;
  const range = active?.line?.expected;
  const nothing = !active && totals.unpaidCount === 0 && totals.shortCount === 0 && totals.advancesCents === 0 && !hos;
  if (nothing) return null;

  return (
    <section aria-label="Pay and hours" className="active-load">
      <h2>Pay and hours</h2>
      {active && (
        <p>
          <Link href={`/loads/${active.loadId}`}>Active load</Link>:{" "}
          {range && range.lowCents !== null && range.highCents !== null ? (
            <strong>{formatRange(range.lowCents, range.highCents)}</strong>
          ) : (
            "can't price yet (no mileage)"
          )}
        </p>
      )}
      {(totals.unpaidCount > 0 || totals.shortCount > 0) && (
        <p>
          <Link href="/money/paychecks">Paychecks</Link>:{" "}
          {totals.unpaidCount > 0 ? `${totals.unpaidCount} finished, unpaid (~${formatRange(totals.unpaidLowCents, totals.unpaidHighCents)})` : ""}
          {totals.unpaidCount > 0 && totals.shortCount > 0 ? " · " : ""}
          {totals.shortCount > 0 ? `${totals.shortCount} short ${formatCents(totals.shortfallCents)}` : ""}
        </p>
      )}
      {totals.advancesCents > 0 && (
        <p>
          <Link href="/money/advances">Cash advances</Link>: {formatCents(totals.advancesCents)} already taken out of your pay
          {totals.unpaidCount > 0 ? ` · unpaid loads should net ~${formatRange(totals.unpaidNetLowCents, totals.unpaidNetHighCents)}` : ""}
        </p>
      )}
      {hos && (
        <p>
          <Link href="/fleet/hos">Hours</Link>: break due in {hm(hos.breakDueInMs)}
          {hos.cycleLeftMs !== null ? ` · ${hm(hos.cycleLeftMs)} left in your ${hos.cycleLabel ?? "cycle"}` : ""}
        </p>
      )}
      <p className="row-sub">Gross at your terms; planning only, not an ELD.</p>
    </section>
  );
}
