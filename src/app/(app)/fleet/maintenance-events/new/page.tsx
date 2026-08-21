"use client";

// Task 3.9 (TASKS.md). Same dollar-to-cents UX pattern as
// money/expenses/new/page.tsx - cost is entered in dollars, converted to
// cost_cents on submit; left blank when the event has no cost (nullable).

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { usePickerList } from "@/lib/use-picker-list";
import { usePageTitle } from "@/lib/use-page-title";
import type { MaintenanceEvent, Truck } from "@/types/entities";

export default function NewMaintenanceEventPage() {
  usePageTitle("Add maintenance event");
  const router = useRouter();
  const [truckId, setTruckId] = useState("");
  const [description, setDescription] = useState("");
  const [costDollars, setCostDollars] = useState("");
  const [serviceDate, setServiceDate] = useState("");
  const [mileage, setMileage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const trucks = usePickerList<Truck>("trucks");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await apiClient.create<MaintenanceEvent>("maintenance-events", {
        truck_id: truckId,
        description,
        cost_cents: costDollars ? Math.round(parseFloat(costDollars) * 100) : null,
        service_date: serviceDate,
        mileage_at_service: mileage ? parseInt(mileage, 10) : null,
      });
      router.push("/fleet/maintenance-events");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1>Add maintenance event</h1>
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

        <label htmlFor="description">Description</label>
        <input
          id="description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          required
        />

        <label htmlFor="cost">Cost ($)</label>
        <input
          id="cost"
          type="number"
          step="0.01"
          min="0"
          value={costDollars}
          onChange={(event) => setCostDollars(event.target.value)}
        />

        <label htmlFor="service_date">Service date</label>
        <input
          id="service_date"
          type="date"
          value={serviceDate}
          onChange={(event) => setServiceDate(event.target.value)}
          required
        />

        <label htmlFor="mileage">Mileage at service</label>
        <input
          id="mileage"
          type="number"
          step="1"
          min="0"
          value={mileage}
          onChange={(event) => setMileage(event.target.value)}
        />

        {error && <p role="alert">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}
