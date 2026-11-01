"use client";

// Task 3.8 (TASKS.md), UI/UX upgrade: same treatment as Expenses -
// purpose header, teaching empty state, amount-led rows with the
// per-gallon truth visible.

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import { usePageTitle } from "@/lib/use-page-title";
import type { FuelPurchase } from "@/types/entities";

export default function FuelPurchasesListPage() {
  usePageTitle("Fuel purchases");
  const { state, retry } = useApiList<FuelPurchase>("fuel-purchases");

  return (
    <div>
      <PageHeader
        title="Fuel purchases"
        purpose="Every fuel stop — fuel is your biggest rolling cost, and Smart Path ranks stops from this history."
        action={
          <Link href="/money/fuel-purchases/new" className="page-action">
            Log fuel
          </Link>
        }
      />

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && state.result.data.length === 0 && (
        <TeachingEmpty
          title="No fuel purchases yet"
          message="Log each stop: gallons, total, where. This history is what your cost-per-mile and Smart Path's fuel picks are computed from."
          action={<Link href="/money/fuel-purchases/new">Log your first fuel stop</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((purchase) => (
            <li key={purchase.id}>
              <span className="row-title">
                ${(purchase.total_cost_cents / 100).toFixed(2)} — {purchase.gallons} gal
                {purchase.location ? ` at ${purchase.location}` : ""}
              </span>
              <span className="row-sub">
                {new Date(purchase.purchased_at).toLocaleDateString()} · $
                {(purchase.price_per_gallon_cents / 100).toFixed(2)}/gal
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
