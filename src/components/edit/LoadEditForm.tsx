"use client";

// LoadEditForm — extracted from the Load detail page (UI/UX Phase 4,
// spec §2.4): ONE form component, two hosts — the detail page's
// Edit Sheet (in-place editing) and the standalone /edit route
// (kept alive for deep links, incl. Abel's). Saving calls the
// caller's onSaved with the updated record; each host decides
// what that means (close the sheet / return to the detail page).

import {useState, type FormEvent} from "react";
import {apiClient, ApiClientError} from "@/lib/api-client";
import {usePickerList} from "@/lib/use-picker-list";
import type {Broker, Customer, Driver, Load, Trailer, Truck} from "@/types/entities";

export default function LoadEditForm({ load, onSaved }: { load: Load; onSaved: (load: Load) => void }) {
  const [origin, setOrigin] = useState(load.origin);
  const [destination, setDestination] = useState(load.destination);
  const [pickupDate, setPickupDate] = useState(load.pickup_date ?? "");
  const [deliveryDate, setDeliveryDate] = useState(load.delivery_date ?? "");
  const [rateDollars, setRateDollars] = useState(
    load.rate_cents != null ? (load.rate_cents / 100).toString() : "",
  );
  const [miles, setMiles] = useState(load.miles != null ? load.miles.toString() : "");
  const [loadedMiles, setLoadedMiles] = useState(load.loaded_miles != null ? load.loaded_miles.toString() : "");
  const [deadheadMiles, setDeadheadMiles] = useState(load.deadhead_miles != null ? load.deadhead_miles.toString() : "");
  const [notes, setNotes] = useState(load.notes ?? "");
  const [truckId, setTruckId] = useState(load.truck_id ?? "");
  const [trailerId, setTrailerId] = useState(load.trailer_id ?? "");
  const [driverId, setDriverId] = useState(load.driver_id ?? "");
  const [brokerId, setBrokerId] = useState(load.broker_id ?? "");
  const [customerId, setCustomerId] = useState(load.customer_id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ path: string; message: string }[]>([]);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const trucks = usePickerList<Truck>("trucks");
  const trailers = usePickerList<Trailer>("trailers");
  const drivers = usePickerList<Driver>("drivers");
  const brokers = usePickerList<Broker>("brokers");
  const customers = usePickerList<Customer>("customers");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors([]);
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await apiClient.update<Load>("loads", load.id, {
        origin,
        destination,
        pickup_date: pickupDate || null,
        delivery_date: deliveryDate || null,
        rate_cents: rateDollars ? Math.round(parseFloat(rateDollars) * 100) : null,
        miles: miles ? Math.round(parseFloat(miles)) : null,
        // Only when filled in and changed (the columns are not clearable here).
        ...(loadedMiles && loadedMiles !== (load.loaded_miles?.toString() ?? "") ? { loaded_miles: parseFloat(loadedMiles) } : {}),
        ...(deadheadMiles && deadheadMiles !== (load.deadhead_miles?.toString() ?? "") ? { deadhead_miles: parseFloat(deadheadMiles) } : {}),
        notes: notes || null,
        truck_id: truckId || null,
        // Only when changed: an untouched trailer never writes the column.
        ...(trailerId !== (load.trailer_id ?? "") ? { trailer_id: trailerId || null } : {}),
        driver_id: driverId || null,
        broker_id: brokerId || null,
        customer_id: customerId || null,
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
    <section aria-label="Edit this load">
      <h2>Edit this load</h2>
      <form onSubmit={handleSubmit}>
        <label htmlFor="edit-origin">Origin</label>
        <input id="edit-origin" value={origin} onChange={(event) => setOrigin(event.target.value)} required />

        <label htmlFor="edit-destination">Destination</label>
        <input
          id="edit-destination"
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
          required
        />

        <label htmlFor="edit-pickup_date">Pickup date</label>
        <input
          id="edit-pickup_date"
          type="date"
          value={pickupDate}
          onChange={(event) => setPickupDate(event.target.value)}
        />

        <label htmlFor="edit-delivery_date">Delivery date</label>
        <input
          id="edit-delivery_date"
          type="date"
          value={deliveryDate}
          onChange={(event) => setDeliveryDate(event.target.value)}
        />

        <label htmlFor="edit-rate">Rate ($)</label>
        <input
          id="edit-rate"
          type="number"
          step="0.01"
          min="0"
          value={rateDollars}
          onChange={(event) => setRateDollars(event.target.value)}
        />

        <label htmlFor="edit-miles">Miles</label>
        <input
          id="edit-miles"
          type="number"
          step="1"
          min="0"
          value={miles}
          onChange={(event) => setMiles(event.target.value)}
        />

        <label htmlFor="edit-loaded-miles">Loaded miles</label>
        <input id="edit-loaded-miles" type="number" step="0.1" min="0" value={loadedMiles} onChange={(event) => setLoadedMiles(event.target.value)} />

        <label htmlFor="edit-deadhead-miles">Deadhead miles</label>
        <input id="edit-deadhead-miles" type="number" step="0.1" min="0" value={deadheadMiles} onChange={(event) => setDeadheadMiles(event.target.value)} />

        <label htmlFor="edit-truck_id">Truck</label>
        <select id="edit-truck_id" value={truckId} onChange={(event) => setTruckId(event.target.value)}>
          <option value="">Unassigned</option>
          {trucks.map((truck) => (
            <option key={truck.id} value={truck.id}>
              {truck.unit_number}
            </option>
          ))}
        </select>

        <label htmlFor="edit-trailer_id">Trailer</label>
        <select id="edit-trailer_id" value={trailerId} onChange={(event) => setTrailerId(event.target.value)}>
          <option value="">Unassigned</option>
          {trailers.map((trailer) => (
            <option key={trailer.id} value={trailer.id}>
              {trailer.unit_number}
            </option>
          ))}
        </select>

        <label htmlFor="edit-driver_id">Driver</label>
        <select id="edit-driver_id" value={driverId} onChange={(event) => setDriverId(event.target.value)}>
          <option value="">Unassigned</option>
          {drivers.map((driver) => (
            <option key={driver.id} value={driver.id}>
              {driver.name}
            </option>
          ))}
        </select>

        <label htmlFor="edit-broker_id">Broker</label>
        <select id="edit-broker_id" value={brokerId} onChange={(event) => setBrokerId(event.target.value)}>
          <option value="">None</option>
          {brokers.map((broker) => (
            <option key={broker.id} value={broker.id}>
              {broker.name}
            </option>
          ))}
        </select>

        <label htmlFor="edit-customer_id">Customer</label>
        <select id="edit-customer_id" value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
          <option value="">None</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </select>

        <label htmlFor="edit-notes">Notes</label>
        <input id="edit-notes" value={notes} onChange={(event) => setNotes(event.target.value)} />

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
