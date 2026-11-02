"use client";

// UI/UX upgrade: the load's own screen. A load's expenses, documents,
// and duty logs were three separate lists in three corners of the app
// with nothing tying them together - this screen is the tie: the
// load's facts up top, everything recorded against it below (the
// expenses/duty-logs list endpoints now whitelist ?load_id=, so each
// section is one exact-match query), and the route check one tap
// away. Fuel is deliberately NOT here: fuel_purchases has no load_id
// in the data model (fuel is recorded per truck), so a per-load fuel
// figure would be invented, not computed.
//
// Reliability Unit A (F-016/F-028): this screen is also where a load's
// record is actually maintained - the edit form below PATCHes through
// merged-record validation, and the status section moves the load
// through its lifecycle (draft -> confirmed -> completed, or
// cancelled) behind the server's completeness rules: confirming needs
// rate + pickup + delivery dates, completing needs a delivery date.
// A refusal comes back as a named 422 and is shown as-is.

import { use, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { DeleteRecordButton } from "@/components/RecordLifecycle";
import { useApiList } from "@/lib/use-api-list";
import { usePickerList } from "@/lib/use-picker-list";
import { usePageTitle } from "@/lib/use-page-title";
import type { Broker, Customer, Driver, DutyLog, Expense, Load, LoadStatus, Truck } from "@/types/entities";

function formatDollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function LoadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Load");
  const [load, setLoad] = useState<Load | null>(null);
  const [error, setError] = useState<string | null>(null);

  const expenses = useApiList<Expense>("expenses", { load_id: id });
  const duty = useApiList<DutyLog>("duty-logs", { load_id: id });

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<Load>("loads", id)
      .then((row) => {
        if (!cancelled) setLoad(row);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this load. Check the connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div>
        <PageHeader title="Load" purpose="One load, in full." />
        <ListError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!load) {
    return (
      <div>
        <PageHeader title="Load" purpose="One load, in full." />
        <ListLoading />
      </div>
    );
  }

  const expenseRows = expenses.state.status === "loaded" ? expenses.state.result.data : [];
  const dutyRows = duty.state.status === "loaded" ? duty.state.result.data : [];
  const expenseCost = expenseRows.reduce((sum, row) => sum + row.amount_cents, 0);

  return (
    <div>
      <PageHeader
        title={`${load.origin} → ${load.destination}`}
        purpose={`Load — ${load.status}. Everything recorded against it, in one place.`}
        action={
          <Link href={`/smart-path?load_id=${load.id}`} className="page-action">
            Route check
          </Link>
        }
      />

      <section aria-label="Load facts">
        <h2>The load</h2>
        <dl>
          <dt>Rate</dt>
          <dd>{load.rate_cents != null ? formatDollars(load.rate_cents) : "—"}</dd>
          <dt>Miles</dt>
          <dd>{load.miles != null ? load.miles.toLocaleString("en-US") : "—"}</dd>
          <dt>Per mile</dt>
          <dd>
            {load.rate_cents != null && load.miles != null && load.miles > 0
              ? `$${(load.rate_cents / 100 / load.miles).toFixed(2)}`
              : "—"}
          </dd>
          <dt>Expenses on it</dt>
          <dd>{expenseCost > 0 ? formatDollars(expenseCost) : "—"}</dd>
        </dl>
        {(load.pickup_date || load.delivery_date) && (
          <p className="row-sub">
            {load.pickup_date
              ? `Pickup ${new Date(`${load.pickup_date}T12:00:00`).toLocaleDateString()}`
              : ""}
            {load.pickup_date && load.delivery_date ? " · " : ""}
            {load.delivery_date
              ? `Deliver ${new Date(`${load.delivery_date}T12:00:00`).toLocaleDateString()}`
              : ""}
          </p>
        )}
        {load.notes && <p>{load.notes}</p>}
      </section>

      <LoadStatusSection key={`status-${load.id}-${load.status}`} load={load} onChanged={setLoad} />

      <section aria-label="Expenses on this load">
        <h2>Expenses on this load</h2>
        {expenseRows.length === 0 ? (
          <p className="row-sub">
            No expenses recorded against this load yet — tolls, lumpers, scales belong here so the load&apos;s
            real profit shows.
          </p>
        ) : (
          <ul>
            {expenseRows.map((row) => (
              <li key={row.id}>
                {formatDollars(row.amount_cents)} — {row.category}
                {row.description ? ` — ${row.description}` : ""}{" "}
                <span className="row-sub">
                  {new Date(`${row.expense_date}T12:00:00`).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="This load's records">
        <h2>Paperwork &amp; logs</h2>
        <ul>
          <li>
            <Link href={`/more/documents?related_entity_type=load&related_entity_id=${load.id}`}>
              Documents — BOL, rate con, receipts
            </Link>
          </li>
          <li>
            Duty entries logged on this load: {dutyRows.length}
            {" — "}
            <Link href="/fleet/hos">Open hours of service</Link>
          </li>
        </ul>
      </section>

      <LoadEditForm key={`edit-${load.id}`} load={load} onSaved={setLoad} />

      <section aria-label="Delete this load">
        <h2>Delete this load</h2>
        <DeleteRecordButton
          resource="loads"
          id={load.id}
          recordName={`Load ${load.origin} → ${load.destination}`}
          listHref="/loads"
          listLabel="loads"
        />
      </section>
    </div>
  );
}

// Draft-completeness checklist + status transitions (design A.4): the
// checklist shows what confirming still needs BEFORE the tap; the
// server enforces the same rules on the merged record and its 422
// names anything still missing.
function LoadStatusSection({
  load,
  onChanged,
}: {
  load: Load;
  onChanged: (load: Load) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const checklist = [
    { label: "Rate", ok: load.rate_cents != null },
    { label: "Pickup date", ok: Boolean(load.pickup_date) },
    { label: "Delivery date", ok: Boolean(load.delivery_date) },
  ];
  const readyToConfirm = checklist.every((item) => item.ok);

  async function transition(status: LoadStatus) {
    setError(null);
    setBusy(true);
    try {
      const updated = await apiClient.update<Load>("loads", load.id, { status });
      onChanged(updated);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't update this load. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Load status">
      <h2>Status — {load.status}</h2>
      {load.status === "draft" && (
        <div>
          <p className="row-sub">
            {readyToConfirm
              ? "This draft has everything confirming needs."
              : "Still needed before this load can be confirmed:"}
          </p>
          <ul>
            {checklist.map((item) => (
              <li key={item.label}>
                {item.ok ? "✓" : "✗"} {item.label}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <p>
        {load.status !== "confirmed" && load.status !== "completed" && (
          <button type="button" disabled={busy} onClick={() => transition("confirmed")}>
            Confirm load
          </button>
        )}{" "}
        {load.status !== "completed" && (
          <button type="button" disabled={busy} onClick={() => transition("completed")}>
            Mark completed
          </button>
        )}{" "}
        {load.status !== "cancelled" && load.status !== "completed" && (
          <button type="button" disabled={busy} onClick={() => transition("cancelled")}>
            Cancel load
          </button>
        )}{" "}
        {(load.status === "cancelled" || load.status === "completed") && (
          <button type="button" disabled={busy} onClick={() => transition("draft")}>
            Back to draft
          </button>
        )}
      </p>
    </section>
  );
}

function LoadEditForm({ load, onSaved }: { load: Load; onSaved: (load: Load) => void }) {
  const [origin, setOrigin] = useState(load.origin);
  const [destination, setDestination] = useState(load.destination);
  const [pickupDate, setPickupDate] = useState(load.pickup_date ?? "");
  const [deliveryDate, setDeliveryDate] = useState(load.delivery_date ?? "");
  const [rateDollars, setRateDollars] = useState(
    load.rate_cents != null ? (load.rate_cents / 100).toString() : "",
  );
  const [miles, setMiles] = useState(load.miles != null ? load.miles.toString() : "");
  const [notes, setNotes] = useState(load.notes ?? "");
  const [truckId, setTruckId] = useState(load.truck_id ?? "");
  const [driverId, setDriverId] = useState(load.driver_id ?? "");
  const [brokerId, setBrokerId] = useState(load.broker_id ?? "");
  const [customerId, setCustomerId] = useState(load.customer_id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ path: string; message: string }[]>([]);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const trucks = usePickerList<Truck>("trucks");
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
        notes: notes || null,
        truck_id: truckId || null,
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

        <label htmlFor="edit-truck_id">Truck</label>
        <select id="edit-truck_id" value={truckId} onChange={(event) => setTruckId(event.target.value)}>
          <option value="">Unassigned</option>
          {trucks.map((truck) => (
            <option key={truck.id} value={truck.id}>
              {truck.unit_number}
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
