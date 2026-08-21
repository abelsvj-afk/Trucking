"use client";

// Task 3.6 (TASKS.md). Saving with missing rate/dates is allowed and
// keeps the load in "draft" - the deliberate alternative workflow from
// docs/user-stories.md, not an error state. Rate is entered in dollars
// and converted to cents on submit - asking for raw cents would be
// unusable, per CLAUDE.md's "must be genuinely usable" rule.
//
// Status field added while building task 5.2's e2e suite: this form
// never sent `status` at all, and loads.status defaults to 'draft' in
// the database (supabase/migrations/00003), so no load created through
// the app could ever reach `confirmed`/`completed` - meaning the
// financial summary's `.in("status", ["confirmed", "completed"])`
// filter (docs/design/data-model.md) could never actually include
// anything. That's the exact "backend works but nothing is reachable
// from the UI" failure docs/design/testing.md's e2e section exists to
// catch. docs/design/data-model.md already frames status as something
// "the owner" moves explicitly ("the owner can move a load backward"),
// not something auto-computed from field completeness - so this is a
// manual selector, defaulting to Draft, not a hidden rule.
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { usePickerList } from "@/lib/use-picker-list";
import { usePageTitle } from "@/lib/use-page-title";
import type { Broker, Customer, Driver, Load, LoadStatus, Truck } from "@/types/entities";

const STATUS_OPTIONS: { label: string; value: LoadStatus }[] = [
  { label: "Draft", value: "draft" },
  { label: "Confirmed", value: "confirmed" },
  { label: "Completed", value: "completed" },
];

export default function NewLoadPage() {
  usePageTitle("Add load");
  const router = useRouter();
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [pickupDate, setPickupDate] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [rateDollars, setRateDollars] = useState("");
  const [status, setStatus] = useState<LoadStatus>("draft");
  const [truckId, setTruckId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [brokerId, setBrokerId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const trucks = usePickerList<Truck>("trucks");
  const drivers = usePickerList<Driver>("drivers");
  const brokers = usePickerList<Broker>("brokers");
  const customers = usePickerList<Customer>("customers");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await apiClient.create<Load>("loads", {
        origin,
        destination,
        pickup_date: pickupDate || undefined,
        delivery_date: deliveryDate || undefined,
        rate_cents: rateDollars ? Math.round(parseFloat(rateDollars) * 100) : undefined,
        status,
        truck_id: truckId || null,
        driver_id: driverId || null,
        broker_id: brokerId || null,
        customer_id: customerId || null,
      });
      router.push("/loads");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1>Add load</h1>
      <form onSubmit={handleSubmit}>
        <label htmlFor="origin">Origin</label>
        <input id="origin" value={origin} onChange={(event) => setOrigin(event.target.value)} required />

        <label htmlFor="destination">Destination</label>
        <input
          id="destination"
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
          required
        />

        <label htmlFor="pickup_date">Pickup date</label>
        <input
          id="pickup_date"
          type="date"
          value={pickupDate}
          onChange={(event) => setPickupDate(event.target.value)}
        />

        <label htmlFor="delivery_date">Delivery date</label>
        <input
          id="delivery_date"
          type="date"
          value={deliveryDate}
          onChange={(event) => setDeliveryDate(event.target.value)}
        />

        <label htmlFor="rate">Rate ($)</label>
        <input
          id="rate"
          type="number"
          step="0.01"
          min="0"
          value={rateDollars}
          onChange={(event) => setRateDollars(event.target.value)}
        />

        <label htmlFor="status">Status</label>
        <select
          id="status"
          value={status}
          onChange={(event) => setStatus(event.target.value as LoadStatus)}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label htmlFor="truck_id">Truck</label>
        <select id="truck_id" value={truckId} onChange={(event) => setTruckId(event.target.value)}>
          <option value="">Unassigned</option>
          {trucks.map((truck) => (
            <option key={truck.id} value={truck.id}>
              {truck.unit_number}
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

        <label htmlFor="broker_id">Broker</label>
        <select id="broker_id" value={brokerId} onChange={(event) => setBrokerId(event.target.value)}>
          <option value="">None</option>
          {brokers.map((broker) => (
            <option key={broker.id} value={broker.id}>
              {broker.name}
            </option>
          ))}
        </select>

        <label htmlFor="customer_id">Customer</label>
        <select
          id="customer_id"
          value={customerId}
          onChange={(event) => setCustomerId(event.target.value)}
        >
          <option value="">None</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </select>

        {error && <p role="alert">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}
