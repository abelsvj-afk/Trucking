"use client";

// Money → Projected pay: the full per-load breakdown behind Home's preview.
// Every row says which miles it counted; while the miles basis is unset the
// totals are a range, labeled. Gross at his stated rate - not net, not cash,
// not a settlement.

import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import { usePayProjection } from "@/lib/use-pay-projection";
import { formatRange } from "@/lib/pay-projection";

export default function ProjectedPayPage() {
  usePageTitle("Projected pay");
  const state = usePayProjection();

  return (
    <div>
      <PageHeader
        title="Projected pay"
        purpose="What this week's loads are worth at your pay terms — updating as loads and details come in."
      />
      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message="Couldn't load your loads or pay terms." onRetry={() => window.location.reload()} />}
      {state.status === "no-terms" && (
        <p>
          You haven&apos;t entered pay terms yet. <Link href="/more/settings">Add them in Settings → Pay terms</Link> and this fills in.
        </p>
      )}
      {state.status === "ready" && (
        <>
          <p role="status">
            <strong>{formatRange(state.period.lowCents, state.period.highCents)}</strong> projected for {state.period.start} to{" "}
            {state.period.end} · {state.terms.employer_name} at ${(state.terms.rate_cents_per_mile / 100).toFixed(2)}/mile
          </p>
          {state.period.basisAssumed && (
            <p role="note">
              Your miles basis isn&apos;t set, so loads show a range — loaded miles only at the low end, all miles (with deadhead)
              at the high end. <Link href="/more/settings">Set which miles are paid</Link> to get one number.
            </p>
          )}
          {state.period.rows.length === 0 && <p>No booked loads this week yet.</p>}
          {state.period.rows.length > 0 && (
            <ul>
              {state.period.rows.map(({ load, projection }) => (
                <li key={load.id}>
                  <span className="row-title">
                    <Link href={`/loads/${load.id}`}>{load.origin} → {load.destination}</Link>
                  </span>
                  <span className="row-sub">
                    {load.delivery_date ?? load.pickup_date} ·{" "}
                    {projection.lowCents === null || projection.highCents === null
                      ? "can't project yet"
                      : formatRange(projection.lowCents, projection.highCents)}
                  </span>
                  <span className="row-sub">{projection.counted ? `Counted: ${projection.counted}. ` : ""}{projection.note}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="row-sub">
            {state.period.excludedCount > 0 ? `${state.period.excludedCount} draft or cancelled load${state.period.excludedCount === 1 ? "" : "s"} left out. ` : ""}
            Gross pay at your stated rate, before fuel, taxes and any deductions. It is a projection — your settlement is the final number.
          </p>
        </>
      )}
    </div>
  );
}
