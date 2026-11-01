"use client";

// UI/UX upgrade: the load's own screen. A load's expenses, documents,
// and duty logs were three separate lists in three corners of the app
// with nothing tying them together - this screen is the tie: the
// load's facts up top, everything recorded against it below (the
// expenses/duty-logs list endpoints now whitelist ?load_id=, so each
// section is one exact-match query), and the route check one tap
// away. Fuel is deliberately NOT here: fuel_purchases has no load_id
// in the data model (fuel is recorded per truck), so a per-load fuel
// figure would be invented, not computed.

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { useApiList } from "@/lib/use-api-list";
import { usePageTitle } from "@/lib/use-page-title";
import type { DutyLog, Expense, Load } from "@/types/entities";

function formatDollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function LoadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Load");
  const [load, setLoad] = useState<Load | null>(null);
  const [error, setError] = useState<string | null>(null);

  const expenses = useApiList<Expense>("expenses", { load_id: id });
  const duty = useApiList<DutyLog>("duty-logs", { load_id: id });

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<Load>("loads", id)
      .then((row) => {
        if (!cancelled) setLoad(row);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this load. Check the connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div>
        <PageHeader title="Load" purpose="One load, in full." />
        <ListError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!load) {
    return (
      <div>
        <PageHeader title="Load" purpose="One load, in full." />
        <ListLoading />
      </div>
    );
  }

  const expenseRows = expenses.state.status === "loaded" ? expenses.state.result.data : [];
  const dutyRows = duty.state.status === "loaded" ? duty.state.result.data : [];
  const expenseCost = expenseRows.reduce((sum, row) => sum + row.amount_cents, 0);

  return (
    <div>
      <PageHeader
        title={`${load.origin} → ${load.destination}`}
        purpose={`Load — ${load.status}. Everything recorded against it, in one place.`}
        action={
          <Link href={`/smart-path?load_id=${load.id}`} className="page-action">
            Route check
          </Link>
        }
      />

      <section aria-label="Load facts">
        <h2>The load</h2>
        <dl>
          <dt>Rate</dt>
          <dd>{load.rate_cents != null ? formatDollars(load.rate_cents) : "—"}</dd>
          <dt>Miles</dt>
          <dd>{load.miles != null ? load.miles.toLocaleString("en-US") : "—"}</dd>
          <dt>Per mile</dt>
          <dd>
            {load.rate_cents != null && load.miles != null && load.miles > 0
              ? `$${(load.rate_cents / 100 / load.miles).toFixed(2)}`
              : "—"}
          </dd>
          <dt>Expenses on it</dt>
          <dd>{expenseCost > 0 ? formatDollars(expenseCost) : "—"}</dd>
        </dl>
        {(load.pickup_date || load.delivery_date) && (
          <p className="row-sub">
            {load.pickup_date
              ? `Pickup ${new Date(`${load.pickup_date}T12:00:00`).toLocaleDateString()}`
              : ""}
            {load.pickup_date && load.delivery_date ? " · " : ""}
            {load.delivery_date
              ? `Deliver ${new Date(`${load.delivery_date}T12:00:00`).toLocaleDateString()}`
              : ""}
          </p>
        )}
        {load.notes && <p>{load.notes}</p>}
      </section>

      <section aria-label="Expenses on this load">
        <h2>Expenses on this load</h2>
        {expenseRows.length === 0 ? (
          <p className="row-sub">
            No expenses recorded against this load yet — tolls, lumpers, scales belong here so the load&apos;s
            real profit shows.
          </p>
        ) : (
          <ul>
            {expenseRows.map((row) => (
              <li key={row.id}>
                {formatDollars(row.amount_cents)} — {row.category}
                {row.description ? ` — ${row.description}` : ""}{" "}
                <span className="row-sub">
                  {new Date(`${row.expense_date}T12:00:00`).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="This load's records">
        <h2>Paperwork &amp; logs</h2>
        <ul>
          <li>
            <Link href={`/more/documents?related_entity_type=load&related_entity_id=${load.id}`}>
              Documents — BOL, rate con, receipts
            </Link>
          </li>
          <li>
            Duty entries logged on this load: {dutyRows.length}
            {" — "}
            <Link href="/fleet/hos">Open hours of service</Link>
          </li>
        </ul>
      </section>
    </div>
  );
}
