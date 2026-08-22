"use client";

// Task 3.15 (TASKS.md). The checklist below is a fixed walkthrough
// prompt, not stored data (docs/schemas.md) - its checkboxes are
// deliberately uncontrolled (no state, nothing submitted); only the
// overall Passed/defects fields below them are real form fields.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { usePickerList } from "@/lib/use-picker-list";
import { usePageTitle } from "@/lib/use-page-title";
import type { PretripInspection, Truck, Trailer, Driver } from "@/types/entities";

const CHECKLIST_ITEMS = [
  "Tires (tread, pressure, damage)",
  "Lights (headlights, brake lights, turn signals, marker lights)",
  "Brakes",
  "Coupling / fifth wheel",
  "Mirrors",
  "Horn",
  "Wipers",
  "Fluid levels (oil, coolant, washer)",
];

export default function NewPretripInspectionPage() {
  usePageTitle("Log inspection");
  const router = useRouter();
  const [vehicleType, setVehicleType] = useState<"truck" | "trailer">("truck");
  const [vehicleId, setVehicleId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [inspectedAt, setInspectedAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [passed, setPassed] = useState(true);
  const [defectsFound, setDefectsFound] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const trucks = usePickerList<Truck>("trucks");
  const trailers = usePickerList<Trailer>("trailers");
  const drivers = usePickerList<Driver>("drivers");
  const vehicles = vehicleType === "truck" ? trucks : trailers;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await apiClient.create<PretripInspection>("pretrip-inspections", {
        truck_id: vehicleType === "truck" ? vehicleId : null,
        trailer_id: vehicleType === "trailer" ? vehicleId : null,
        driver_id: driverId || null,
        inspected_at: new Date(inspectedAt).toISOString(),
        passed,
        defects_found: defectsFound || null,
      });
      router.push("/fleet/pretrip-inspections");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1>Log inspection</h1>

      <section aria-label="Checklist">
        <h2>Walk through before logging</h2>
        <ul>
          {CHECKLIST_ITEMS.map((item) => (
            <li key={item}>
              <label>
                <input type="checkbox" defaultChecked={false} /> {item}
              </label>
            </li>
          ))}
        </ul>
      </section>

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

        <label htmlFor="driver_id">Driver</label>
        <select id="driver_id" value={driverId} onChange={(event) => setDriverId(event.target.value)}>
          <option value="">Unassigned</option>
          {drivers.map((driver) => (
            <option key={driver.id} value={driver.id}>
              {driver.name}
            </option>
          ))}
        </select>

        <label htmlFor="inspected_at">Inspected at</label>
        <input
          id="inspected_at"
          type="datetime-local"
          value={inspectedAt}
          onChange={(event) => setInspectedAt(event.target.value)}
          required
        />

        <label htmlFor="passed">Result</label>
        <select
          id="passed"
          value={passed ? "pass" : "fail"}
          onChange={(event) => setPassed(event.target.value === "pass")}
        >
          <option value="pass">Passed</option>
          <option value="fail">Failed</option>
        </select>

        <label htmlFor="defects_found">Defects found</label>
        <input
          id="defects_found"
          value={defectsFound}
          onChange={(event) => setDefectsFound(event.target.value)}
          placeholder="e.g. Trailer pigtail connector loose"
        />

        {error && <p role="alert">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}
