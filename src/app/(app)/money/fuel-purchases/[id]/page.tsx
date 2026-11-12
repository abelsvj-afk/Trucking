"use client";

// Reliability Unit A: the fuel purchase's own screen. Before this, a
// fuel purchase was a line in a list with no way to see it in full,
// fix a typo'd total, or delete it. Here: the purchase's facts up
// top, an edit form mirroring the Add fuel purchase fields (PATCH on
// save), and the delete control at the bottom.

import {use, useEffect, useState} from "react";
import Link from "next/link";
import {apiClient} from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import Sheet from "@/components/Sheet";
import FuelPurchaseEditForm from "@/components/edit/FuelPurchaseEditForm";
import {ListLoading, ListError} from "@/components/ListStates";
import {DeleteRecordButton} from "@/components/RecordLifecycle";
import FuelLoadPicker from "@/components/FuelLoadPicker";
import {usePageTitle} from "@/lib/use-page-title";
import {formatDate} from "@/lib/time";
import {deriveFuelTotal} from "@/lib/fuel-math";
import type {FuelPurchase} from "@/types/entities";
import { formatMoney } from "@/lib/money-format";

export default function FuelPurchaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Fuel purchase");
  const [purchase, setPurchase] = useState<FuelPurchase | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<FuelPurchase>("fuel-purchases", id)
      .then((row) => {
        if (!cancelled) setPurchase(row);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this fuel purchase. Check the connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div>
        <PageHeader title="Fuel purchase" purpose="One fuel purchase, in full." />
        <ListError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!purchase) {
    return (
      <div>
        <PageHeader title="Fuel purchase" purpose="One fuel purchase, in full." />
        <ListLoading />
      </div>
    );
  }

  const purchaseDate = formatDate(purchase.purchased_at);

  return (
    <div>
      <PageHeader
        title={purchase.location ? `Fuel at ${purchase.location}` : "Fuel purchase"}
        purpose={`${formatMoney(purchase.total_cost_cents)} on ${purchaseDate} — its details, and the record controls, in one place.`}
      
        action={
          <button type="button" className="page-action" onClick={() => setEditOpen(true)}>
            Edit
          </button>
        }
      />

      <section aria-label="Fuel purchase facts">
        <h2>The fuel purchase</h2>
        <dl>
          <dt>Location</dt>
          <dd>{purchase.location ?? "—"}</dd>
          <dt>Gallons</dt>
          <dd>{purchase.gallons}</dd>
          <dt>Price per gallon</dt>
          <dd>{formatMoney(purchase.price_per_gallon_cents)}/gal</dd>
          <dt>Computed base</dt>
          <dd>
            {formatMoney(
              deriveFuelTotal(purchase.gallons, purchase.price_per_gallon_cents).baseCents,
            )}
          </dd>
          {purchase.adjustment_cents !== 0 && (
            <>
              <dt>Adjustment</dt>
              <dd>
                {formatMoney(purchase.adjustment_cents)}
                {purchase.adjustment_reason ? ` — ${purchase.adjustment_reason}` : ""}
              </dd>
            </>
          )}
          <dt>Total cost</dt>
          <dd>{formatMoney(purchase.total_cost_cents)}</dd>
          <dt>Date</dt>
          <dd>{purchaseDate}</dd>
        </dl>
      </section>

      {editOpen && (
          <Sheet title="Edit fuel purchase" onClose={() => setEditOpen(false)}>
            <FuelPurchaseEditForm key={purchase.id} purchase={purchase} onSaved={(updated) => { setPurchase(updated); setEditOpen(false); }} />
          </Sheet>
        )}

      <p>
        <Link href="/money/fuel-purchases">Back to fuel purchases</Link>
      </p>

      <section aria-label="Delete this fuel purchase">
        <h2>Delete this fuel purchase</h2>
        <DeleteRecordButton
          resource="fuel-purchases"
          id={purchase.id}
          recordName={
            purchase.location
              ? `fuel purchase at ${purchase.location} (${formatMoney(purchase.total_cost_cents)})`
              : `fuel purchase on ${purchaseDate} (${formatMoney(purchase.total_cost_cents)})`
          }
          listHref="/money/fuel-purchases"
          listLabel="fuel purchases"
        />
      </section>
    </div>
  );
}
