"use client";

// Reliability Unit A: the inspection's own screen - read-only
// summary, an edit form mirroring fleet/pretrip-inspections/new's
// stored fields (the walkthrough checklist there is a prompt, not
// stored data), and the delete section. Mirrors the truck detail
// screen's shape.

import { use, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { DeleteRecordButton } from "@/components/RecordLifecycle";
import { usePickerList } from "@/lib/use-picker-list";
import { usePageTitle } from "@/lib/use-page-title";
import { formatDate, formatDateTime, localDateTimeInputValue } from "@/lib/time";
import type { PretripInspection, Truck, Trailer, Driver } from "@/types/entities";

export default function PretripInspectionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Pre-trip inspection");
  const [record, setRecord] = useState<PretripInspection | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<PretripInspection>("pretrip-inspections", id)
      .then((row) => {
        if (!cancelled) setRecord(row);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this inspection. Check the connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div>
        <PageHeader title="Pre-trip inspection" purpose="One inspection, in full." />
        <ListError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!record) {
    return (
      <div>
        <PageHeader title="Pre-trip inspection" purpose="One inspection, in full." />
        <ListLoading />
      </div>
    );
  }

  const recordName = `${record.passed ? "Passed" : "Failed"} inspection — ${formatDate(record.inspected_at)}`;

  return (
    <div>
      <PageHeader title={recordName} purpose="One inspection, in full." />

      <section aria-label="Summary">
        <h2>Summary</h2>
        <dl>
          <dt>Result</dt>
          <dd>{record.passed ? "Passed" : "Failed"}</dd>
          <dt>Inspected at</dt>
          <dd>{formatDateTime(record.inspected_at)}</dd>
          <dt>Defects found</dt>
          <dd>{record.defects_found ?? "None"}</dd>
        </dl>
      </section>

      <PretripInspectionEditForm key={record.id} record={record} onSaved={setRecord} />

      <p>
        <Link href="/fleet/pretrip-inspections">Back to pre-trip inspections</Link>
      </p>

      <section aria-label="Delete this record">
        <h2>Delete this record</h2>
        <DeleteRecordButton
          resource="pretrip-inspections"
          id={record.id}
          recordName={recordName}
          listHref="/fleet/pretrip-inspections"
          listLabel="pre-trip inspections"
        />
      </section>
    </div>
  );
}

function PretripInspectionEditForm({
  record,
  onSaved,
}: {
  record: PretripInspection;
  onSaved: (row: PretripInspection) => void;
}) {
  const [vehicleType, setVehicleType] = useState<"truck" | "trailer">(
    record.truck_id ? "truck" : "trailer",
  );
  const [vehicleId, setVehicleId] = useState(record.truck_id ?? record.trailer_id ?? "");
  const [driverId, setDriverId] = useState(record.driver_id ?? "");
  const [inspectedAt, setInspectedAt] = useState(() =>
    localDateTimeInputValue(new Date(record.inspected_at)),
  );
  const [passed, setPassed] = useState(record.passed);
  const [defectsFound, setDefectsFound] = useState(record.defects_found ?? "");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ path: string; message: string }[]>([]);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const trucks = usePickerList<Truck>("trucks");
  const trailers = usePickerList<Trailer>("trailers");
  const drivers = usePickerList<Driver>("drivers");
  const vehicles = vehicleType === "truck" ? trucks : trailers;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors([]);
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await apiClient.update<PretripInspection>("pretrip-inspections", record.id, {
        truck_id: vehicleType === "truck" ? vehicleId : null,
        trailer_id: vehicleType === "trailer" ? vehicleId : null,
        driver_id: driverId || null,
        inspected_at: new Date(inspectedAt).toISOString(),
        passed,
        defects_found: defectsFound || null,
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
