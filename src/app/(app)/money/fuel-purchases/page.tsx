"use client";

// Task 3.8 (TASKS.md). Same pattern as money/expenses/page.tsx.

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, ListEmpty, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import type { FuelPurchase } from "@/types/entities";

export default function FuelPurchasesListPage() {
  usePageTitle("Fuel purchases");
  const { state, retry } = useApiList<FuelPurchase>("fuel-purchases");

  return (
    <div>
      <h1>Fuel purchases</h1>
      <Link href="/money/fuel-purchases/new">Add fuel purchase</Link>

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && state.result.data.length === 0 && (
        <ListEmpty
          message="No fuel purchases yet — add your first one."
          action={<Link href="/money/fuel-purchases/new">Add fuel purchase</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((purchase) => (
            <li key={purchase.id}>
              {purchase.purchased_at} — {purchase.gallons} gal — $
              {(purchase.total_cost_cents / 100).toFixed(2)}
              {purchase.location && ` at ${purchase.location}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
