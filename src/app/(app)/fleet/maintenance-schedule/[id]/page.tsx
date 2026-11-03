"use client";

// Reliability Unit A: the schedule item's own screen - read-only
// summary, an edit form mirroring fleet/maintenance-schedule/new,
// and the delete section. Mirrors the truck detail screen's shape.

import { use, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { DeleteRecordButton } from "@/components/RecordLifecycle";
import { usePickerList } from "@/lib/use-picker-list";
import { usePageTitle } from "@/lib/use-page-title";
import type { MaintenanceSchedule, Truck, Trailer } from "@/types/entities";

export default function MaintenanceScheduleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Schedule item");
  const [record, setRecord] = useState<MaintenanceSchedule | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<MaintenanceSchedule>("maintenance-schedules", id)
      .then((row) => {
        if (!cancelled) setRecord(row);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this schedule item. Check the connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div>
        <PageHeader title="Schedule item" purpose="One recurring item, in full." />
        <ListError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!record) {
    return (
      <div>
        <PageHeader title="Schedule item" purpose="One recurring item, in full." />
        <ListLoading />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={record.description} purpose="One recurring item, in full." />

      <section aria-label="Summary">
        <h2>Summary</h2>
        <dl>
          <dt>Description</dt>
          <dd>{record.description}</dd>
          <dt>Status</dt>
          <dd>{record.status}</dd>
          <dt>Interval (miles)</dt>
          <dd>{record.interval_miles != null ? record.interval_miles.toLocaleString("en-US") : "Not set"}</dd>
          <dt>Interval (days)</dt>
          <dd>{record.interval_days != null ? record.interval_days : "Not set"}</dd>
          <dt>Last done (date)</dt>
          <dd>
            {record.last_done_date
              ? new Date(`${record.last_done_date}T12:00:00`).toLocaleDateString()
              : "Not recorded"}
          </dd>
          <dt>Last done (mileage)</dt>
          <dd>
            {record.last_done_mileage != null
              ? record.last_done_mileage.toLocaleString("en-US")
              : "Not recorded"}
          </dd>
        </dl>
      </section>

      <MaintenanceScheduleEditForm key={record.id} record={record} onSaved={setRecord} />

      <p>
        <Link href="/fleet/maintenance-schedule">Back to maintenance schedule</Link>
      </p>

      <section aria-label="Delete this record">
        <h2>Delete this record</h2>
        <DeleteRecordButton
          resource="maintenance-schedules"
          id={record.id}
          recordName={record.description}
          listHref="/fleet/maintenance-schedule"
          listLabel="maintenance schedule"
        />
      </section>
    </div>
  );
}

function MaintenanceScheduleEditForm({
  record,
  onSaved,
}: {
  record: MaintenanceSchedule;
  onSaved: (row: MaintenanceSchedule) => void;
}) {
  const [vehicleType, setVehicleType] = useState<"truck" | "trailer">(
    record.truck_id ? "truck" : "trailer",
  );
  const [vehicleId, setVehicleId] = useState(record.truck_id ?? record.trailer_id ?? "");
  const [description, setDescription] = useState(record.description);
  const [intervalMiles, setIntervalMiles] = useState(
    record.interval_miles != null ? String(record.interval_miles) : "",
  );
  const [intervalDays, setIntervalDays] = useState(
    record.interval_days != null ? String(record.interval_days) : "",
  );
  const [lastDoneDate, setLastDoneDate] = useState(record.last_done_date ?? "");
  const [lastDoneMileage, setLastDoneMileage] = useState(
    record.last_done_mileage != null ? String(record.last_done_mileage) : "",
  );
  const [status, setStatus] = useState<MaintenanceSchedule["status"]>(record.status);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ path: string; message: string }[]>([]);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const trucks = usePickerList<Truck>("trucks");
  const trailers = usePickerList<Trailer>("trailers");
  const vehicles = vehicleType === "truck" ? trucks : trailers;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors([]);
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await apiClient.update<MaintenanceSchedule>("maintenance-schedules", record.id, {
        truck_id: vehicleType === "truck" ? vehicleId : null,
        trailer_id: vehicleType === "trailer" ? vehicleId : null,
        description,
        interval_miles: intervalMiles ? parseInt(intervalMiles, 10) : null,
        interval_days: intervalDays ? parseInt(intervalDays, 10) : null,
        last_done_date: lastDoneDate || null,
        last_done_mileage: lastDoneMileage ? parseInt(lastDoneMileage, 10) : null,
        status,
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

      <label htmlFor="status">Status</label>
      <select
        id="status"
        value={status}
        onChange={(event) => setStatus(event.target.value as MaintenanceSchedule["status"])}
      >
        <option value="active">Active</option>
        <option value="paused">Paused</option>
      </select>

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
