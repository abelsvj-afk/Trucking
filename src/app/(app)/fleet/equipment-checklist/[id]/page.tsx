"use client";

// Reliability Unit A: the checklist item's own screen - read-only
// summary, an edit form mirroring fleet/equipment-checklist/new,
// and the delete section. Mirrors the truck detail screen's shape.

import { use, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { DeleteRecordButton } from "@/components/RecordLifecycle";
import { usePickerList } from "@/lib/use-picker-list";
import { usePageTitle } from "@/lib/use-page-title";
import type { EquipmentChecklistItem, Truck, Trailer } from "@/types/entities";

export default function EquipmentChecklistItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Checklist item");
  const [record, setRecord] = useState<EquipmentChecklistItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<EquipmentChecklistItem>("equipment-checklist-items", id)
      .then((row) => {
        if (!cancelled) setRecord(row);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this checklist item. Check the connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div>
        <PageHeader title="Checklist item" purpose="One checklist item, in full." />
        <ListError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!record) {
    return (
      <div>
        <PageHeader title="Checklist item" purpose="One checklist item, in full." />
        <ListLoading />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={record.item_name} purpose="One checklist item, in full." />

      <section aria-label="Summary">
        <h2>Summary</h2>
        <dl>
          <dt>Item</dt>
          <dd>{record.item_name}</dd>
          <dt>Quantity on hand</dt>
          <dd>{record.quantity_on_hand != null ? record.quantity_on_hand : "Not recorded"}</dd>
          <dt>Last checked</dt>
          <dd>
            {record.last_checked_date
              ? new Date(`${record.last_checked_date}T12:00:00`).toLocaleDateString()
              : "Not recorded"}
          </dd>
          <dt>Notes</dt>
          <dd>{record.notes ?? "None"}</dd>
        </dl>
      </section>

      <EquipmentChecklistItemEditForm key={record.id} record={record} onSaved={setRecord} />

      <p>
        <Link href="/fleet/equipment-checklist">Back to equipment checklist</Link>
      </p>

      <section aria-label="Delete this record">
        <h2>Delete this record</h2>
        <DeleteRecordButton
          resource="equipment-checklist-items"
          id={record.id}
          recordName={record.item_name}
          listHref="/fleet/equipment-checklist"
          listLabel="equipment checklist"
        />
      </section>
    </div>
  );
}

function EquipmentChecklistItemEditForm({
  record,
  onSaved,
}: {
  record: EquipmentChecklistItem;
  onSaved: (row: EquipmentChecklistItem) => void;
}) {
  const [vehicleType, setVehicleType] = useState<"truck" | "trailer">(
    record.truck_id ? "truck" : "trailer",
  );
  const [vehicleId, setVehicleId] = useState(record.truck_id ?? record.trailer_id ?? "");
  const [itemName, setItemName] = useState(record.item_name);
  const [quantity, setQuantity] = useState(
    record.quantity_on_hand != null ? String(record.quantity_on_hand) : "",
  );
  const [lastCheckedDate, setLastCheckedDate] = useState(record.last_checked_date ?? "");
  const [notes, setNotes] = useState(record.notes ?? "");
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
      const updated = await apiClient.update<EquipmentChecklistItem>(
        "equipment-checklist-items",
        record.id,
        {
          truck_id: vehicleType === "truck" ? vehicleId : null,
          trailer_id: vehicleType === "trailer" ? vehicleId : null,
          item_name: itemName,
          quantity_on_hand: quantity ? parseInt(quantity, 10) : null,
          last_checked_date: lastCheckedDate || null,
          notes: notes || null,
        },
      );
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
