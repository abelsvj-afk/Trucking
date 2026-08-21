"use client";

// Task 3.8 (TASKS.md). Same dollar/gallon-to-cents UX pattern as
// money/expenses/new/page.tsx - gallons and price-per-gallon are entered
// directly, total cost in dollars and converted to cents on submit.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { usePickerList } from "@/lib/use-picker-list";
import type { FuelPurchase, Truck } from "@/types/entities";

export default function NewFuelPurchasePage() {
  const router = useRouter();
  const [truckId, setTruckId] = useState("");
  const [location, setLocation] = useState("");
  const [gallons, setGallons] = useState("");
  const [pricePerGallonDollars, setPricePerGallonDollars] = useState("");
  const [totalCostDollars, setTotalCostDollars] = useState("");
  const [purchasedAt, setPurchasedAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const trucks = usePickerList<Truck>("trucks");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await apiClient.create<FuelPurchase>("fuel-purchases", {
        truck_id: truckId,
        location: location || undefined,
        gallons: parseFloat(gallons || "0"),
        price_per_gallon_cents: Math.round(parseFloat(pricePerGallonDollars || "0") * 100),
        total_cost_cents: Math.round(parseFloat(totalCostDollars || "0") * 100),
        purchased_at: purchasedAt,
      });
      router.push("/money/fuel-purchases");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1>Add fuel purchase</h1>
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

        <label htmlFor="location">Location</label>
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

        <label htmlFor="total_cost">Total cost ($)</label>
        <input
          id="total_cost"
          type="number"
          step="0.01"
          min="0"
          value={totalCostDollars}
          onChange={(event) => setTotalCostDollars(event.target.value)}
          required
        />

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
