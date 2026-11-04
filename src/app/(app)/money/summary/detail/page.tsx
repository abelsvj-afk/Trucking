"use client";

// Reliability Unit C (task C3 - design C.3, finding F-010): the rows
// behind one financial-summary total. Deliberately simple - a plain
// list in the same row idiom as the entity lists, each row linking to
// the record's own screen. The rich drill-down (cross-links, per-load
// grouping) is F-049 in Wave 2; this page is the truthful minimum:
// what you see sums exactly to the total you came from, because the
// API reconciles the two inside one snapshot before answering.

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { ListLoading, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import { usePageTitle } from "@/lib/use-page-title";
import { formatDate } from "@/lib/time";
import type { FinancialSummaryDetail } from "@/types/financial-summary";

function formatDollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

const TITLES: Record<string, string> = {
  revenue: "Revenue — loads delivered",
  expenses: "Expenses",
  fuel: "Fuel",
  maintenance: "Maintenance",
};

function rowHref(component: string, id: string): string {
  switch (component) {
    case "revenue":
      return `/loads/${id}`;
    case "expenses":
      return `/money/expenses/${id}`;
    case "fuel":
      return `/money/fuel-purchases/${id}`;
    case "maintenance":
      return `/fleet/maintenance-events/${id}`;
    default:
      return "#";
  }
}

function rowLabel(component: string, row: Record<string, unknown>): { title: string; sub: string } {
  switch (component) {
    case "revenue":
      return {
        title: `${String(row.origin ?? "")} → ${String(row.destination ?? "")}`,
        sub: `Delivered ${row.delivery_date ? formatDate(String(row.delivery_date)) : "—"}`,
      };
    case "expenses":
      return {
        title: String(row.description ?? row.category ?? "Expense"),
        sub: `${String(row.category ?? "")} · ${row.expense_date ? formatDate(String(row.expense_date)) : ""}`,
      };
    case "fuel": {
      const adjustment = Number(row.adjustment_cents ?? 0);
      return {
        title: row.location ? `Fuel at ${String(row.location)}` : "Fuel purchase",
        sub:
          `${String(row.gallons ?? "")} gal · ${row.purchased_at ? formatDate(String(row.purchased_at)) : ""}` +
          (adjustment !== 0
            ? ` · adjustment ${formatDollars(adjustment)}${row.adjustment_reason ? ` — ${String(row.adjustment_reason)}` : ""}`
            : ""),
      };
    }
    case "maintenance":
      return {
        title: String(row.description ?? "Maintenance"),
        sub: row.service_date ? formatDate(String(row.service_date)) : "",
      };
    default:
      return { title: String(row.id ?? ""), sub: "" };
  }
}

const AMOUNT_FIELD: Record<string, string> = {
  revenue: "rate_cents",
  expenses: "amount_cents",
  fuel: "total_cost_cents",
  maintenance: "cost_cents",
};

function DetailContent() {
  const searchParams = useSearchParams();
  const component = searchParams.get("component") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const [detail, setDetail] = useState<FinancialSummaryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .financialSummaryDetail(component, { from, to })
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof ApiClientError ? err.message : "Couldn't load these rows. Try again.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [component, from, to]);

  if (error) {
    return <ListError message={error} onRetry={() => window.location.reload()} />;
  }
  if (!detail) return <ListLoading />;

  const amountField = AMOUNT_FIELD[detail.component] ?? "";

  return (
    <div>
      <p>
        {detail.range.from} – {detail.range.to} · {detail.row_count}{" "}
        {detail.row_count === 1 ? "record" : "records"} · total{" "}
        {formatDollars(detail.total_cents)}
      </p>
      {detail.rows.length === 0 ? (
        <p>No records make up this total for the range.</p>
      ) : (
        <ul>
          {detail.rows.map((row) => {
            const label = rowLabel(detail.component, row);
            const id = String(row.id ?? "");
            return (
              <li key={id}>
                <Link href={rowHref(detail.component, id)}>
                  <span className="row-title">
                    {formatDollars(Number(row[amountField] ?? 0))} — {label.title}
                  </span>
                  <span className="row-sub">{label.sub}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <p>
        <Link href="/money/summary">Back to financial summary</Link>
      </p>
    </div>
  );
}

function DetailPage() {
  usePageTitle("Summary detail");
  const searchParams = useSearchParams();
  const component = searchParams.get("component") ?? "";
  return (
    <div>
      <PageHeader
        title={TITLES[component] ?? "Summary detail"}
        purpose="Every record behind the total — if it's counted, it's listed here."
      />
      <DetailContent />
    </div>
  );
}

export default function FinancialSummaryDetailPage() {
  return (
    <Suspense fallback={<ListLoading />}>
      <DetailPage />
    </Suspense>
  );
}
