"use client";

// Task 3.13 (TASKS.md). "Vehicle type" + "Vehicle" mirrors the
// type+record picker pattern already used in more/documents/page.tsx -
// exactly one of truck_id/trailer_id is required
// (docs/design/data-model.md), so the form picks a type first to keep
// the record dropdown scoped to the right list.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { usePickerList } from "@/lib/use-picker-list";
import { usePageTitle } from "@/lib/use-page-title";
import type { MaintenanceSchedule, Truck, Trailer } from "@/types/entities";

export default function NewMaintenanceSchedulePage() {
  usePageTitle("Add schedule item");
  const router = useRouter();
  const [vehicleType, setVehicleType] = useState<"truck" | "trailer">("truck");
  const [vehicleId, setVehicleId] = useState("");
  const [description, setDescription] = useState("");
  const [intervalMiles, setIntervalMiles] = useState("");
  const [intervalDays, setIntervalDays] = useState("");
  const [lastDoneDate, setLastDoneDate] = useState("");
  const [lastDoneMileage, setLastDoneMileage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const trucks = usePickerList<Truck>("trucks");
  const trailers = usePickerList<Trailer>("trailers");
  const vehicles = vehicleType === "truck" ? trucks : trailers;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await apiClient.create<MaintenanceSchedule>("maintenance-schedules", {
        truck_id: vehicleType === "truck" ? vehicleId : null,
        trailer_id: vehicleType === "trailer" ? vehicleId : null,
        description,
        interval_miles: intervalMiles ? parseInt(intervalMiles, 10) : null,
        interval_days: intervalDays ? parseInt(intervalDays, 10) : null,
        last_done_date: lastDoneDate || null,
        last_done_mileage: lastDoneMileage ? parseInt(lastDoneMileage, 10) : null,
      });
      router.push("/fleet/maintenance-schedule");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1>Add schedule item</h1>
      <form onSubmit={handleSubmit}>
        <label htmlFor="vehicle_type">Vehicle type</label>
        <select
          id="vehicle_type"
          value={vehicleType}
          onChange={(event) => {
            setVehicleType(event.target.value as "truck" | "trailer");
            setVehicleId("");
          }}
        >
          <option value="truck">Truck</option>
          <option value="trailer">Trailer</option>
        </select>

        <label htmlFor="vehicle_id">Vehicle</label>
        <select
          id="vehicle_id"
          value={vehicleId}
          onChange={(event) => setVehicleId(event.target.value)}
          required
        >
          <option value="">Select a vehicle</option>
          {vehicles.map((vehicle) => (
            <option key={vehicle.id} value={vehicle.id}>
              {vehicle.unit_number}
            </option>
          ))}
        </select>

        <label htmlFor="description">Description</label>
        <input
          id="description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          required
          placeholder="e.g. Oil change, Inspect trailer pigtail"
        />

        <label htmlFor="interval_miles">Interval (miles)</label>
        <input
          id="interval_miles"
          type="number"
          step="1"
          min="1"
          value={intervalMiles}
          onChange={(event) => setIntervalMiles(event.target.value)}
        />

        <label htmlFor="interval_days">Interval (days)</label>
        <input
          id="interval_days"
          type="number"
          step="1"
          min="1"
          value={intervalDays}
          onChange={(event) => setIntervalDays(event.target.value)}
        />

        <label htmlFor="last_done_date">Last done (date)</label>
        <input
          id="last_done_date"
          type="date"
          value={lastDoneDate}
          onChange={(event) => setLastDoneDate(event.target.value)}
        />

        <label htmlFor="last_done_mileage">Last done (mileage)</label>
        <input
          id="last_done_mileage"
          type="number"
          step="1"
          min="0"
          value={lastDoneMileage}
          onChange={(event) => setLastDoneMileage(event.target.value)}
        />

        {error && <p role="alert">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}
