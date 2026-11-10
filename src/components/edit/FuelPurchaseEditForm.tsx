"use client";

// FuelPurchaseEditForm — extracted from the FuelPurchase detail page (UI/UX Phase 4,
// spec §2.4): ONE form component, two hosts — the detail page's
// Edit Sheet (in-place editing) and the standalone /edit route
// (kept alive for deep links, incl. Abel's). Saving calls the
// caller's onSaved with the updated record; each host decides
// what that means (close the sheet / return to the detail page).

import {useState, type FormEvent} from "react";
import {apiClient, ApiClientError} from "@/lib/api-client";
import {usePickerList} from "@/lib/use-picker-list";
import FuelLoadPicker from "@/components/FuelLoadPicker";
import {formatDollars} from "@/lib/truck-fund";
import {deriveFuelTotal} from "@/lib/fuel-math";
import type {FuelPurchase, Truck} from "@/types/entities";

export default function FuelPurchaseEditForm({
  purchase,
  onSaved,
}: {
  purchase: FuelPurchase;
  onSaved: (purchase: FuelPurchase) => void;
}) {
  const [truckId, setTruckId] = useState(purchase.truck_id);
  const [loadId, setLoadId] = useState(purchase.load_id ?? "");
  const [location, setLocation] = useState(purchase.location ?? "");
  const [gallons, setGallons] = useState(purchase.gallons.toString());
  const [pricePerGallonDollars, setPricePerGallonDollars] = useState(
    (purchase.price_per_gallon_cents / 100).toString(),
  );
  // Unit C (D-04): no free total field - the total re-derives from
  // gallons/price/adjustment on save; the adjustment is the only
  // editable part of the difference.
  const [adjustmentDollars, setAdjustmentDollars] = useState(
    (purchase.adjustment_cents / 100).toString(),
  );
  const [adjustmentReason, setAdjustmentReason] = useState(purchase.adjustment_reason ?? "");
  const [purchasedAt, setPurchasedAt] = useState(purchase.purchased_at.slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ path: string; message: string }[]>([]);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const trucks = usePickerList<Truck>("trucks");

  const editGallonsValue = parseFloat(gallons || "0");
  const editPriceCents = Math.round(parseFloat(pricePerGallonDollars || "0") * 100);
  const editAdjustmentCents = Math.round(parseFloat(adjustmentDollars || "0") * 100);
  let editDerived: ReturnType<typeof deriveFuelTotal> | null = null;
  try {
    if (editGallonsValue > 0) {
      editDerived = deriveFuelTotal(editGallonsValue, editPriceCents, editAdjustmentCents);
    }
  } catch {
    editDerived = null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors([]);
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await apiClient.update<FuelPurchase>("fuel-purchases", purchase.id, {
        truck_id: truckId,
        load_id: loadId || null,
        location: location || null,
        gallons: parseFloat(gallons || "0"),
        price_per_gallon_cents: Math.round(parseFloat(pricePerGallonDollars || "0") * 100),
        adjustment_cents: Math.round(parseFloat(adjustmentDollars || "0") * 100),
        adjustment_reason: adjustmentReason || null,
        purchased_at: purchasedAt,
      });
      onSaved(updated);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
        setFieldErrors(err.fields ?? []);
      } else {
        setError("Couldn't save. Try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-label="Edit this fuel purchase">
      <h2>Edit this fuel purchase</h2>
      <form onSubmit={handleSubmit}>
        <label htmlFor="edit-truck_id">Truck</label>
        <select
          id="edit-truck_id"
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

        <FuelLoadPicker id="edit-load_id" value={loadId} onChange={setLoadId} truckId={truckId} purchasedAt={purchasedAt} />

        <label htmlFor="edit-location">Location</label>
        <input id="edit-location" value={location} onChange={(event) => setLocation(event.target.value)} />

        <label htmlFor="edit-gallons">Gallons</label>
        <input
          id="edit-gallons"
          type="number"
          step="0.001"
          min="0.001"
          value={gallons}
          onChange={(event) => setGallons(event.target.value)}
          required
        />

        <label htmlFor="edit-price_per_gallon">Price per gallon ($)</label>
        <input
          id="edit-price_per_gallon"
          type="number"
          step="0.001"
          min="0"
          value={pricePerGallonDollars}
          onChange={(event) => setPricePerGallonDollars(event.target.value)}
          required
        />

        <label htmlFor="edit-adjustment">Adjustment ($) — only if the receipt total differs</label>
        <input
          id="edit-adjustment"
          type="number"
          step="0.01"
          value={adjustmentDollars}
          onChange={(event) => setAdjustmentDollars(event.target.value)}
        />

        {editAdjustmentCents !== 0 && (
          <>
            <label htmlFor="edit-adjustment_reason">Adjustment reason (required)</label>
            <input
              id="edit-adjustment_reason"
              value={adjustmentReason}
              onChange={(event) => setAdjustmentReason(event.target.value)}
              required
            />
          </>
        )}

        <p aria-live="polite">
          {editDerived
            ? `Base ${formatDollars(editDerived.baseCents)} · Total ${formatDollars(editDerived.totalCents)} (calculated)`
            : "Total is calculated from gallons and price."}
        </p>

        <label htmlFor="edit-purchased_at">Date</label>
        <input
          id="edit-purchased_at"
          type="date"
          value={purchasedAt}
          onChange={(event) => setPurchasedAt(event.target.value)}
          required
        />

        {error && <p role="alert">{error}</p>}
        {fieldErrors.length > 0 && (
          <ul role="alert">
            {fieldErrors.map((field) => (
              <li key={`${field.path}-${field.message}`}>
                {field.path}: {field.message}
              </li>
            ))}
          </ul>
        )}
        {saved && <p role="status">Saved.</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save changes"}
        </button>
      </form>
    </section>
  );
}
