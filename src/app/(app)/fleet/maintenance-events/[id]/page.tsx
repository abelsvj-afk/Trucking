"use client";

// Reliability Unit A: the maintenance event's own screen - read-only
// summary, an edit form mirroring fleet/maintenance-events/new, and
// the delete section. Mirrors the truck detail screen's shape.

import { use, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { DeleteRecordButton } from "@/components/RecordLifecycle";
import { usePickerList } from "@/lib/use-picker-list";
import { usePageTitle } from "@/lib/use-page-title";
import type { MaintenanceEvent, Truck } from "@/types/entities";

export default function MaintenanceEventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Maintenance event");
  const [record, setRecord] = useState<MaintenanceEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<MaintenanceEvent>("maintenance-events", id)
      .then((row) => {
        if (!cancelled) setRecord(row);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this maintenance event. Check the connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div>
        <PageHeader title="Maintenance event" purpose="One maintenance event, in full." />
        <ListError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!record) {
    return (
      <div>
        <PageHeader title="Maintenance event" purpose="One maintenance event, in full." />
        <ListLoading />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={record.description} purpose="One maintenance event, in full." />

      <section aria-label="Summary">
        <h2>Summary</h2>
        <dl>
          <dt>Description</dt>
          <dd>{record.description}</dd>
          <dt>Service date</dt>
          <dd>{new Date(`${record.service_date}T12:00:00`).toLocaleDateString()}</dd>
          <dt>Cost</dt>
          <dd>{record.cost_cents != null ? `$${(record.cost_cents / 100).toFixed(2)}` : "Not recorded"}</dd>
          <dt>Mileage at service</dt>
          <dd>
            {record.mileage_at_service != null
              ? `${record.mileage_at_service.toLocaleString("en-US")} mi`
              : "Not recorded"}
          </dd>
        </dl>
      </section>

      <MaintenanceEventEditForm key={record.id} record={record} onSaved={setRecord} />

      <p>
        <Link href="/fleet/maintenance-events">Back to maintenance events</Link>
      </p>

      <section aria-label="Delete this record">
        <h2>Delete this record</h2>
        <DeleteRecordButton
          resource="maintenance-events"
          id={record.id}
          recordName={record.description}
          listHref="/fleet/maintenance-events"
          listLabel="maintenance events"
        />
      </section>
    </div>
  );
}

function MaintenanceEventEditForm({
  record,
  onSaved,
}: {
  record: MaintenanceEvent;
  onSaved: (row: MaintenanceEvent) => void;
}) {
  const [truckId, setTruckId] = useState(record.truck_id);
  const [description, setDescription] = useState(record.description);
  const [costDollars, setCostDollars] = useState(
    record.cost_cents != null ? String(record.cost_cents / 100) : "",
  );
  const [serviceDate, setServiceDate] = useState(record.service_date);
  const [mileage, setMileage] = useState(
    record.mileage_at_service != null ? String(record.mileage_at_service) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ path: string; message: string }[]>([]);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const trucks = usePickerList<Truck>("trucks");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors([]);
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await apiClient.update<MaintenanceEvent>("maintenance-events", record.id, {
        truck_id: truckId,
        description,
        cost_cents: costDollars ? Math.round(parseFloat(costDollars) * 100) : null,
        service_date: serviceDate,
        mileage_at_service: mileage ? parseInt(mileage, 10) : null,
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
      {fieldErrors.map((field) => (
        <p key={`${field.path}-${field.message}`} role="alert">
          {field.path}: {field.message}
        </p>
      ))}
      {saved && <p role="status">Saved.</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
