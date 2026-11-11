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
import { useSubmissionId } from "@/lib/use-submission-id";
import { usePageTitle } from "@/lib/use-page-title";
import PageHeader from "@/components/PageHeader";
import type { Broker, Customer, Driver, Facility, Load, LoadStatus, Trailer, Truck } from "@/types/entities";

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
  // GAP-02/04: appointment windows + detention terms, straight off
  // the rate con when he has them — optional like everything else.
  const [pickupWindowStart, setPickupWindowStart] = useState("");
  const [pickupWindowEnd, setPickupWindowEnd] = useState("");
  const [deliveryWindowStart, setDeliveryWindowStart] = useState("");
  const [deliveryWindowEnd, setDeliveryWindowEnd] = useState("");
  const [detentionFreeMinutes, setDetentionFreeMinutes] = useState("");
  const [detentionRateDollars, setDetentionRateDollars] = useState("");
  const [rateDollars, setRateDollars] = useState("");
  // Mileage drives the pay projection and the paycheck check; a finished load
  // can be entered after the fact (status Completed) with its real miles.
  const [loadedMiles, setLoadedMiles] = useState("");
  const [deadheadMiles, setDeadheadMiles] = useState("");
  const [status, setStatus] = useState<LoadStatus>("draft");
  const [truckId, setTruckId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [brokerId, setBrokerId] = useState("");
  const [customerId, setCustomerId] = useState("");
  // GAP-03: pick a remembered facility instead of re-typing the place.
  const [pickupFacilityId, setPickupFacilityId] = useState("");
  const [deliveryFacilityId, setDeliveryFacilityId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // One idempotency token per form opening (Unit A / F-006): retries
  // and double-taps replay this create instead of duplicating the load.
  const submissionId = useSubmissionId();

  const trucks = usePickerList<Truck>("trucks");
  const trailers = usePickerList<Trailer>("trailers");
  const [trailerId, setTrailerId] = useState("");
  const drivers = usePickerList<Driver>("drivers");
  const brokers = usePickerList<Broker>("brokers");
  const customers = usePickerList<Customer>("customers");
  const facilities = usePickerList<Facility>("facilities");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await apiClient.create<Load>("loads", {
        submission_id: submissionId,
        origin,
        destination,
        pickup_date: pickupDate || undefined,
        delivery_date: deliveryDate || undefined,
        pickup_window_start: pickupWindowStart ? new Date(pickupWindowStart).toISOString() : undefined,
        pickup_window_end: pickupWindowEnd ? new Date(pickupWindowEnd).toISOString() : undefined,
        delivery_window_start: deliveryWindowStart
          ? new Date(deliveryWindowStart).toISOString()
          : undefined,
        delivery_window_end: deliveryWindowEnd
          ? new Date(deliveryWindowEnd).toISOString()
          : undefined,
        detention_free_minutes: detentionFreeMinutes
          ? Number.parseInt(detentionFreeMinutes, 10)
          : undefined,
        detention_rate_cents_per_hour: detentionRateDollars
          ? Math.round(parseFloat(detentionRateDollars) * 100)
          : undefined,
        rate_cents: rateDollars ? Math.round(parseFloat(rateDollars) * 100) : undefined,
        ...(loadedMiles ? { loaded_miles: parseFloat(loadedMiles) } : {}),
        ...(deadheadMiles ? { deadhead_miles: parseFloat(deadheadMiles) } : {}),
        ...(loadedMiles || deadheadMiles
          ? { miles: Math.round(parseFloat(loadedMiles || "0") + parseFloat(deadheadMiles || "0")) }
          : {}),
        status,
        truck_id: truckId || null,
        ...(trailerId ? { trailer_id: trailerId } : {}),
        driver_id: driverId || null,
        broker_id: brokerId || null,
        customer_id: customerId || null,
        pickup_facility_id: pickupFacilityId || null,
        delivery_facility_id: deliveryFacilityId || null,
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
      <PageHeader title="Add load" purpose="The lane, the rate, and the dates — profit, route checks, and per-mile math all compute from this." />
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

        <label htmlFor="pickup_date">Pickup date (optional)</label>
        <input
          id="pickup_date"
          type="date"
          value={pickupDate}
          onChange={(event) => setPickupDate(event.target.value)}
        />

        <label htmlFor="delivery_date">Delivery date (optional)</label>
        <input
          id="delivery_date"
          type="date"
          value={deliveryDate}
          onChange={(event) => setDeliveryDate(event.target.value)}
        />

        <label htmlFor="rate">Rate ($) (optional)</label>
        <input
          id="rate"
          type="number"
          step="0.01"
          min="0"
          value={rateDollars}
          onChange={(event) => setRateDollars(event.target.value)}
        />

        <label htmlFor="loaded_miles">Loaded miles (optional)</label>
        <input id="loaded_miles" type="number" step="0.1" min="0" value={loadedMiles} onChange={(event) => setLoadedMiles(event.target.value)} />

        <label htmlFor="deadhead_miles">Deadhead miles (optional)</label>
        <input id="deadhead_miles" type="number" step="0.1" min="0" value={deadheadMiles} onChange={(event) => setDeadheadMiles(event.target.value)} />

        <label htmlFor="status">Status (choose Completed to enter a load you already finished)</label>
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

        <label htmlFor="truck_id">Truck (optional)</label>
        <select id="truck_id" value={truckId} onChange={(event) => setTruckId(event.target.value)}>
          <option value="">Unassigned</option>
          {trucks.map((truck) => (
            <option key={truck.id} value={truck.id}>
              {truck.unit_number}
            </option>
          ))}
        </select>

        <label htmlFor="trailer_id">Trailer (optional)</label>
        <select id="trailer_id" value={trailerId} onChange={(event) => setTrailerId(event.target.value)}>
          <option value="">Unassigned</option>
          {trailers.map((trailer) => (
            <option key={trailer.id} value={trailer.id}>
              {trailer.unit_number}
            </option>
          ))}
        </select>

        <label htmlFor="driver_id">Driver (optional)</label>
        <select id="driver_id" value={driverId} onChange={(event) => setDriverId(event.target.value)}>
          <option value="">Unassigned</option>
          {drivers.map((driver) => (
            <option key={driver.id} value={driver.id}>
              {driver.name}
            </option>
          ))}
        </select>

        <details className="form-more">
          <summary>
            Appointment times and detention
            <span className="form-more-hint">Optional - off the rate con</span>
          </summary>
        <label htmlFor="pickup_window_start">Pickup window starts (from the rate con) (optional)</label>
        <input
          id="pickup_window_start"
          type="datetime-local"
          value={pickupWindowStart}
          onChange={(event) => setPickupWindowStart(event.target.value)}
        />

        <label htmlFor="pickup_window_end">Pickup window ends (optional)</label>
        <input
          id="pickup_window_end"
          type="datetime-local"
          value={pickupWindowEnd}
          onChange={(event) => setPickupWindowEnd(event.target.value)}
        />

        <label htmlFor="delivery_window_start">Delivery window starts (optional)</label>
        <input
          id="delivery_window_start"
          type="datetime-local"
          value={deliveryWindowStart}
          onChange={(event) => setDeliveryWindowStart(event.target.value)}
        />

        <label htmlFor="delivery_window_end">Delivery window ends (optional)</label>
        <input
          id="delivery_window_end"
          type="datetime-local"
          value={deliveryWindowEnd}
          onChange={(event) => setDeliveryWindowEnd(event.target.value)}
        />

        <label htmlFor="detention_free_minutes">Detention: free minutes before it bills (optional)</label>
        <input
          id="detention_free_minutes"
          type="number"
          min="0"
          step="15"
          value={detentionFreeMinutes}
          onChange={(event) => setDetentionFreeMinutes(event.target.value)}
        />

        <label htmlFor="detention_rate">Detention rate ($/hour after free time) (optional)</label>
        <input
          id="detention_rate"
          type="number"
          step="0.01"
          min="0"
          value={detentionRateDollars}
          onChange={(event) => setDetentionRateDollars(event.target.value)}
        />
        </details>

        <details className="form-more">
          <summary>
            Broker, customer and places
            <span className="form-more-hint">Optional</span>
          </summary>
        <label htmlFor="broker_id">Broker (optional)</label>
        <select id="broker_id" value={brokerId} onChange={(event) => setBrokerId(event.target.value)}>
          <option value="">None</option>
          {brokers.map((broker) => (
            <option key={broker.id} value={broker.id}>
              {broker.name}
            </option>
          ))}
        </select>

        <label htmlFor="pickup_facility_id">Pickup facility (remembered place) (optional)</label>
        <select
          id="pickup_facility_id"
          value={pickupFacilityId}
          onChange={(event) => setPickupFacilityId(event.target.value)}
        >
          <option value="">None</option>
          {facilities.map((facility) => (
            <option key={facility.id} value={facility.id}>
              {facility.name}
              {facility.city ? ` — ${facility.city}` : ""}
            </option>
          ))}
        </select>

        <label htmlFor="delivery_facility_id">Delivery facility (remembered place) (optional)</label>
        <select
          id="delivery_facility_id"
          value={deliveryFacilityId}
          onChange={(event) => setDeliveryFacilityId(event.target.value)}
        >
          <option value="">None</option>
          {facilities.map((facility) => (
            <option key={facility.id} value={facility.id}>
              {facility.name}
              {facility.city ? ` — ${facility.city}` : ""}
            </option>
          ))}
        </select>

        <label htmlFor="customer_id">Customer (optional)</label>
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
        </details>


        {error && <p role="alert">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}
