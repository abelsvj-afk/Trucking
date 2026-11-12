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
import { formatDate } from "@/lib/time";
import type { FuelPurchase } from "@/types/entities";
import { formatMoney } from "@/lib/money-format";

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
              ? `${purchase.location} — ${purchase.gallons} gal — ${formatMoney(purchase.total_cost_cents)}`
              : `${formatDate(purchase.purchased_at)} — ${purchase.gallons} gal — ${formatMoney(purchase.total_cost_cents)}`
          }
          sublabelFor={(purchase: FuelPurchase) =>
            purchase.location ? formatDate(purchase.purchased_at) : null
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
          {/* Newest by the purchase's own date, not by when it was logged. */}
          {[...state.result.data].sort((a, b) => b.purchased_at.localeCompare(a.purchased_at)).map((purchase) => (
            <li key={purchase.id}>
              <Link href={`/money/fuel-purchases/${purchase.id}`}>
                <span className="row-title">
                  {formatMoney(purchase.total_cost_cents)} — {purchase.gallons} gal
                  {purchase.location ? ` at ${purchase.location}` : ""}
                </span>
                <span className="row-sub">
                  {formatDate(purchase.purchased_at)} · {formatMoney(purchase.price_per_gallon_cents)}/gal
                  {purchase.adjustment_cents !== 0
                    ? ` · incl. adjustment ${formatMoney(purchase.adjustment_cents)}${
                        purchase.adjustment_reason ? ` — ${purchase.adjustment_reason}` : ""
                      }`
                    : ""}
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
