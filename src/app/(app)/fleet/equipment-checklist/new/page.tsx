"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { usePickerList } from "@/lib/use-picker-list";
import { usePageTitle } from "@/lib/use-page-title";
import type { EquipmentChecklistItem, Truck, Trailer } from "@/types/entities";

export default function NewEquipmentChecklistItemPage() {
  usePageTitle("Add checklist item");
  const router = useRouter();
  const [vehicleType, setVehicleType] = useState<"truck" | "trailer">("truck");
  const [vehicleId, setVehicleId] = useState("");
  const [itemName, setItemName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [lastCheckedDate, setLastCheckedDate] = useState("");
  const [notes, setNotes] = useState("");
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
      await apiClient.create<EquipmentChecklistItem>("equipment-checklist-items", {
        truck_id: vehicleType === "truck" ? vehicleId : null,
        trailer_id: vehicleType === "trailer" ? vehicleId : null,
        item_name: itemName,
        quantity_on_hand: quantity ? parseInt(quantity, 10) : null,
        last_checked_date: lastCheckedDate || null,
        notes: notes || null,
      });
      router.push("/fleet/equipment-checklist");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1>Add checklist item</h1>
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

        <label htmlFor="item_name">Item</label>
        <input
          id="item_name"
          value={itemName}
          onChange={(event) => setItemName(event.target.value)}
          required
          placeholder="e.g. Zip ties, Spare fuses (ATO 20A)"
        />

        <label htmlFor="quantity">Quantity on hand</label>
        <input
          id="quantity"
          type="number"
          step="1"
          min="0"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
        />

        <label htmlFor="last_checked_date">Last checked</label>
        <input
          id="last_checked_date"
          type="date"
          value={lastCheckedDate}
          onChange={(event) => setLastCheckedDate(event.target.value)}
        />

        <label htmlFor="notes">Notes</label>
        <input id="notes" value={notes} onChange={(event) => setNotes(event.target.value)} />

        {error && <p role="alert">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}
