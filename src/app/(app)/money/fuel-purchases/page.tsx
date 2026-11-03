"use client";

// Task 3.8 (TASKS.md), UI/UX upgrade: same treatment as Expenses -
// purpose header, teaching empty state, amount-led rows with the
// per-gallon truth visible.

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import { usePageTitle } from "@/lib/use-page-title";
import {
  useDeletedToggle,
  DeletedToggleButton,
  DeletedListSection,
} from "@/components/RecordLifecycle";
import { formatDollars } from "@/lib/truck-fund";
import type { FuelPurchase } from "@/types/entities";

export default function FuelPurchasesListPage() {
  usePageTitle("Fuel purchases");
  const [showDeleted, setShowDeleted] = useDeletedToggle();
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

      <DeletedToggleButton
        showDeleted={showDeleted}
        onChange={setShowDeleted}
        listLabel="fuel purchases"
      />

      {showDeleted ? (
        <DeletedListSection
          resource="fuel-purchases"
          labelFor={(purchase: FuelPurchase) =>
            purchase.location
              ? `${purchase.location} — ${purchase.gallons} gal — ${formatDollars(purchase.total_cost_cents)}`
              : `${new Date(purchase.purchased_at).toLocaleDateString()} — ${purchase.gallons} gal — ${formatDollars(purchase.total_cost_cents)}`
          }
          sublabelFor={(purchase: FuelPurchase) =>
            purchase.location ? new Date(purchase.purchased_at).toLocaleDateString() : null
          }
        />
      ) : (
        <>
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
              <Link href={`/money/fuel-purchases/${purchase.id}`}>
                <span className="row-title">
                  ${(purchase.total_cost_cents / 100).toFixed(2)} — {purchase.gallons} gal
                  {purchase.location ? ` at ${purchase.location}` : ""}
                </span>
                <span className="row-sub">
                  {new Date(purchase.purchased_at).toLocaleDateString()} · $
                  {(purchase.price_per_gallon_cents / 100).toFixed(2)}/gal
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
        </>
      )}
    </div>
  );
}
