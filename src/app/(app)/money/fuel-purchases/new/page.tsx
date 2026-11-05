"use client";

// Task 3.8 (TASKS.md). Same dollar/gallon-to-cents UX pattern as
// money/expenses/new/page.tsx - gallons and price-per-gallon are
// entered directly.
//
// Reliability Unit C (design C.4, ruling D-04): there is no total
// field to type into anymore. The total is DERIVED - gallons x price
// per gallon, computed live below with the same integer math the API
// and the database use (lib/fuel-math.ts) - plus an optional
// adjustment with a reason for genuine receipt differences (taxes,
// discounts, rebates). The form submits gallons/price/adjustment
// only; the server derives and stores the total.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { offlineOutbox } from "@/lib/offline-outbox";
import { usePickerList } from "@/lib/use-picker-list";
import FuelLoadPicker from "@/components/FuelLoadPicker";
import { useSubmissionId } from "@/lib/use-submission-id";
import { usePageTitle } from "@/lib/use-page-title";
import PageHeader from "@/components/PageHeader";
import { deriveFuelTotal } from "@/lib/fuel-math";
import type { FuelPurchase, Truck } from "@/types/entities";

function formatDollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function NewFuelPurchasePage() {
  usePageTitle("Add fuel purchase");
  const router = useRouter();
  const [truckId, setTruckId] = useState("");
  const [loadId, setLoadId] = useState("");
  const [location, setLocation] = useState("");
  const [gallons, setGallons] = useState("");
  const [pricePerGallonDollars, setPricePerGallonDollars] = useState("");
  const [adjustmentDollars, setAdjustmentDollars] = useState("");
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [purchasedAt, setPurchasedAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // One idempotency token per form opening (Unit A / F-006): retries
  // and double-taps replay this create instead of duplicating the purchase.
  const submissionId = useSubmissionId();

  const trucks = usePickerList<Truck>("trucks");

  const gallonsValue = parseFloat(gallons || "0");
  const priceCents = Math.round(parseFloat(pricePerGallonDollars || "0") * 100);
  const adjustmentCents = Math.round(parseFloat(adjustmentDollars || "0") * 100);
  let derived: ReturnType<typeof deriveFuelTotal> | null = null;
  try {
    if (gallonsValue > 0) derived = deriveFuelTotal(gallonsValue, priceCents, adjustmentCents);
  } catch {
    derived = null; // precision the contract refuses - the API will say so
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const body = {
      submission_id: submissionId,
      truck_id: truckId,
      ...(loadId ? { load_id: loadId } : {}),
      location: location || undefined,
      gallons: gallonsValue,
      price_per_gallon_cents: priceCents,
      ...(adjustmentCents !== 0
        ? { adjustment_cents: adjustmentCents, adjustment_reason: adjustmentReason || undefined }
        : {}),
      purchased_at: purchasedAt,
    };
    try {
      await apiClient.create<FuelPurchase>("fuel-purchases", body);
      router.push("/money/fuel-purchases");
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        // GAP-07: no signal is not a lost fuel stop — queue it on
        // the device; it sends itself when signal returns.
        offlineOutbox.enqueue("fuel-purchases", body);
        router.push("/money/fuel-purchases");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader title="Add fuel purchase" purpose="Gallons, price, and where — the total figures itself out. Thirty seconds now is your cost per mile later." />
      <form onSubmit={handleSubmit}>
        <label htmlFor="truck_id">Truck</label>
        <select
          id="truck_id"
          value={truckId}
          onChange={(event) => setTruckId(event.target.value)}
          required
        >
          <option value="">Select a truck</option>
          {trucks.map((truck) => (
            <option key={truck.id} value={truck.id}>
              {truck.unit_number}
            </option>
          ))}
        </select>

        <FuelLoadPicker id="load_id" value={loadId} onChange={setLoadId} truckId={truckId} purchasedAt={purchasedAt} />

        <label htmlFor="location">Location (optional)</label>
        <input id="location" value={location} onChange={(event) => setLocation(event.target.value)} />

        <label htmlFor="gallons">Gallons</label>
        <input
          id="gallons"
          type="number"
          step="0.001"
          min="0.001"
          value={gallons}
          onChange={(event) => setGallons(event.target.value)}
          required
        />

        <label htmlFor="price_per_gallon">Price per gallon ($)</label>
        <input
          id="price_per_gallon"
          type="number"
          step="0.001"
          min="0"
          value={pricePerGallonDollars}
          onChange={(event) => setPricePerGallonDollars(event.target.value)}
          required
        />

        <label htmlFor="adjustment">Adjustment ($) — only if the receipt total differs</label>
        <input
          id="adjustment"
          type="number"
          step="0.01"
          value={adjustmentDollars}
          onChange={(event) => setAdjustmentDollars(event.target.value)}
        />

        {adjustmentCents !== 0 && (
          <>
            <label htmlFor="adjustment_reason">Adjustment reason (required)</label>
            <input
              id="adjustment_reason"
              value={adjustmentReason}
              onChange={(event) => setAdjustmentReason(event.target.value)}
              required
            />
          </>
        )}

        <p aria-live="polite">
          {derived
            ? `Base ${formatDollars(derived.baseCents)}${
                adjustmentCents !== 0 ? ` · adjustment ${formatDollars(adjustmentCents)}` : ""
              } · Total ${formatDollars(derived.totalCents)}`
            : "Total is calculated from gallons and price."}
        </p>

        <label htmlFor="purchased_at">Date</label>
        <input
          id="purchased_at"
          type="date"
          value={purchasedAt}
          onChange={(event) => setPurchasedAt(event.target.value)}
          required
        />

        {error && <p role="alert">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}
