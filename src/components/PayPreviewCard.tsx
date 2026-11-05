"use client";

// Home's small pay preview: this week's projected pay across his loads, from
// his own pay terms (lib/pay-projection.ts). Says what it is counting - while
// his miles basis is unset it shows a range and says so, never a quiet guess.
// Gross at his stated rate; his settlement is the truth.

import Link from "next/link";
import { usePayProjection } from "@/lib/use-pay-projection";
import { formatRange } from "@/lib/pay-projection";

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
  return (
    <section aria-label="Projected pay" className="active-load">
      <h2>Projected pay this week</h2>
      {period.rows.length === 0 ? (
        <p className="row-sub">No booked loads this week yet.</p>
      ) : (
        <>
          <p className="active-load-route">
            <strong>{formatRange(period.lowCents, period.highCents)}</strong>
          </p>
          <p className="row-sub">
            {period.rows.length} load{period.rows.length === 1 ? "" : "s"} at {terms.employer_name}&apos;s{" "}
            ${(terms.rate_cents_per_mile / 100).toFixed(2)}/mile
            {period.unavailableCount > 0 ? ` · ${period.unavailableCount} can't be projected yet (no mileage)` : ""}
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
