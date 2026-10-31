"use client";

// Driver MVP (docs/design/driver-mvp.md §3). Log the START of a duty
// status; it runs until the next status you log (lib/hos.ts derives
// the segments). Same form pattern as pretrip-inspections/new.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { usePickerList } from "@/lib/use-picker-list";
import { usePageTitle } from "@/lib/use-page-title";
import type { DutyLog, DutyStatus, Driver, Load } from "@/types/entities";

export default function NewDutyLogPage() {
  usePageTitle("Log duty status");
  const router = useRouter();
  const [driverId, setDriverId] = useState("");
  const [loadId, setLoadId] = useState("");
  const [dutyStatus, setDutyStatus] = useState<DutyStatus>("on_duty");
  const [startedAt, setStartedAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [location, setLocation] = useState("");
  const [odometer, setOdometer] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const drivers = usePickerList<Driver>("drivers");
  const loads = usePickerList<Load>("loads");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await apiClient.create<DutyLog>("duty-logs", {
        driver_id: driverId || null,
        load_id: loadId || null,
        duty_status: dutyStatus,
        started_at: new Date(startedAt).toISOString(),
        location: location || null,
        odometer: odometer ? Number(odometer) : null,
        notes: notes || null,
      });
      router.push("/fleet/hos");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1>Log duty status</h1>
      <p>
        Log the moment a status <strong>starts</strong> - it runs until
        the next status you log. Paper-log helper, not an ELD.
      </p>

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

        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}
