"use client";

// Reliability Unit A: the duty log's own screen - read-only summary,
// an edit form mirroring fleet/hos/new, and the delete section.
// Mirrors the truck detail screen's shape on purpose.

import { use, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { DeleteRecordButton } from "@/components/RecordLifecycle";
import { usePickerList } from "@/lib/use-picker-list";
import { usePageTitle } from "@/lib/use-page-title";
import type { DutyLog, DutyStatus, Driver, Load } from "@/types/entities";

const STATUS_LABELS: Record<DutyLog["duty_status"], string> = {
  off_duty: "Off duty",
  sleeper: "Sleeper",
  driving: "Driving",
  on_duty: "On duty (not driving)",
};

export default function DutyLogDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Duty log");
  const [record, setRecord] = useState<DutyLog | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<DutyLog>("duty-logs", id)
      .then((row) => {
        if (!cancelled) setRecord(row);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this duty log. Check the connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div>
        <PageHeader title="Duty log" purpose="One duty status, in full." />
        <ListError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!record) {
    return (
      <div>
        <PageHeader title="Duty log" purpose="One duty status, in full." />
        <ListLoading />
      </div>
    );
  }

  const recordName = `${STATUS_LABELS[record.duty_status]} — ${new Date(record.started_at).toLocaleDateString()}`;

  return (
    <div>
      <PageHeader title={recordName} purpose="One duty status, in full. Paper-log helper, not an ELD." />

      <section aria-label="Summary">
        <h2>Summary</h2>
        <dl>
          <dt>Duty status</dt>
          <dd>{STATUS_LABELS[record.duty_status]}</dd>
          <dt>Started at</dt>
          <dd>{new Date(record.started_at).toLocaleString()}</dd>
          <dt>Location</dt>
          <dd>{record.location ?? "Not recorded"}</dd>
          <dt>Odometer</dt>
          <dd>{record.odometer != null ? record.odometer.toLocaleString("en-US") : "Not recorded"}</dd>
          <dt>Notes</dt>
          <dd>{record.notes ?? "None"}</dd>
        </dl>
      </section>

      <DutyLogEditForm key={record.id} record={record} onSaved={setRecord} />

      <p>
        <Link href="/fleet/hos">Back to duty logs</Link>
      </p>

      <section aria-label="Delete this record">
        <h2>Delete this record</h2>
        <DeleteRecordButton
          resource="duty-logs"
          id={record.id}
          recordName={recordName}
          listHref="/fleet/hos"
          listLabel="duty logs"
        />
      </section>
    </div>
  );
}

function DutyLogEditForm({ record, onSaved }: { record: DutyLog; onSaved: (row: DutyLog) => void }) {
  const [driverId, setDriverId] = useState(record.driver_id ?? "");
  const [loadId, setLoadId] = useState(record.load_id ?? "");
  const [dutyStatus, setDutyStatus] = useState<DutyStatus>(record.duty_status);
  const [startedAt, setStartedAt] = useState(() => new Date(record.started_at).toISOString().slice(0, 16));
  const [location, setLocation] = useState(record.location ?? "");
  const [odometer, setOdometer] = useState(record.odometer != null ? String(record.odometer) : "");
  const [notes, setNotes] = useState(record.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ path: string; message: string }[]>([]);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const drivers = usePickerList<Driver>("drivers");
  const loads = usePickerList<Load>("loads");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors([]);
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await apiClient.update<DutyLog>("duty-logs", record.id, {
        driver_id: driverId || null,
        load_id: loadId || null,
        duty_status: dutyStatus,
        started_at: new Date(startedAt).toISOString(),
        location: location || null,
        odometer: odometer ? Number(odometer) : null,
        notes: notes || null,
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
      <label htmlFor="driver_id">Driver</label>
      <select id="driver_id" value={driverId} onChange={(event) => setDriverId(event.target.value)}>
        <option value="">Unassigned</option>
        {drivers.map((driver) => (
          <option key={driver.id} value={driver.id}>
            {driver.name}
          </option>
        ))}
      </select>

      <label htmlFor="load_id">Load</label>
      <select id="load_id" value={loadId} onChange={(event) => setLoadId(event.target.value)}>
        <option value="">No load</option>
        {loads.map((load) => (
          <option key={load.id} value={load.id}>
            {load.origin} → {load.destination}
          </option>
        ))}
      </select>

      <label htmlFor="duty_status">Duty status</label>
      <select
        id="duty_status"
        value={dutyStatus}
        onChange={(event) => setDutyStatus(event.target.value as DutyStatus)}
      >
        <option value="off_duty">Off duty</option>
        <option value="sleeper">Sleeper berth</option>
        <option value="driving">Driving</option>
        <option value="on_duty">On duty (not driving)</option>
      </select>

      <label htmlFor="started_at">Started at</label>
      <input
        id="started_at"
        type="datetime-local"
        value={startedAt}
        onChange={(event) => setStartedAt(event.target.value)}
        required
      />

      <label htmlFor="location">Location</label>
      <input
        id="location"
        value={location}
        onChange={(event) => setLocation(event.target.value)}
        placeholder="e.g. Melbourne, FL"
      />

      <label htmlFor="odometer">Odometer</label>
      <input
        id="odometer"
        type="number"
        min="0"
        value={odometer}
        onChange={(event) => setOdometer(event.target.value)}
      />

      <label htmlFor="notes">Notes</label>
      <input id="notes" value={notes} onChange={(event) => setNotes(event.target.value)} />

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
