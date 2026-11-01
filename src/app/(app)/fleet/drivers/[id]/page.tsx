"use client";

// UI/UX upgrade: the driver's own screen - photo, the complete
// profile as an edit form, and the way through to their documents.
// Mirrors the truck detail screen's shape on purpose: one pattern
// for every fleet record.

import { use, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { EntityPhoto, PhotoUpload } from "@/components/EntityPhoto";
import DriverProfileFields, {
  driverProfileFromDriver,
  driverProfileToPayload,
  type DriverProfileValues,
} from "@/components/DriverProfileFields";
import { usePickerList } from "@/lib/use-picker-list";
import { usePageTitle } from "@/lib/use-page-title";
import { driverRoleLabel } from "@/lib/fleet-display";
import type { Driver, Truck } from "@/types/entities";

export default function DriverDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Driver");
  const [driver, setDriver] = useState<Driver | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<Driver>("drivers", id)
      .then((row) => {
        if (!cancelled) setDriver(row);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this driver. Check the connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div>
        <PageHeader title="Driver" purpose="One driver, in full." />
        <ListError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!driver) {
    return (
      <div>
        <PageHeader title="Driver" purpose="One driver, in full." />
        <ListLoading />
      </div>
    );
  }

  const role = driverRoleLabel(driver.role);

  return (
    <div>
      <PageHeader
        title={driver.name}
        purpose={role ? `${role} — contact, license, and assignment in one place.` : "Contact, license, and assignment in one place."}
      />

      <EntityPhoto
        entityType="driver"
        entityId={driver.id}
        photoDocumentId={driver.photo_document_id}
        size="hero"
        alt={`Photo of ${driver.name}`}
      />
      <PhotoUpload
        entityType="driver"
        entityId={driver.id}
        resource="drivers"
        hasPhoto={driver.photo_document_id != null}
        onUploaded={(documentId) => setDriver({ ...driver, photo_document_id: documentId })}
      />

      {driver.cdl_expires_on && (
        <section aria-label="License">
          <h2>License</h2>
          <dl>
            <dt>CDL number</dt>
            <dd style={{ fontSize: "1.125rem" }}>{driver.cdl_number ?? "Not recorded"}</dd>
            <dt>CDL expires</dt>
            <dd style={{ fontSize: "1.125rem" }}>
              {new Date(`${driver.cdl_expires_on}T12:00:00`).toLocaleDateString()}
            </dd>
          </dl>
        </section>
      )}

      <section aria-label="Related records">
        <h2>This driver&apos;s records</h2>
        <ul>
          <li>
            <Link href={`/more/documents?related_entity_type=driver&related_entity_id=${driver.id}`}>
              Documents — CDL, medical card, photos
            </Link>
          </li>
          <li>
            <Link href="/fleet/hos">Duty logs</Link>
          </li>
          <li>
            <Link href="/fleet/pretrip-inspections">Pre-trip inspections</Link>
          </li>
        </ul>
      </section>

      <DriverEditForm key={driver.id} driver={driver} onSaved={setDriver} />
    </div>
  );
}

function DriverEditForm({ driver, onSaved }: { driver: Driver; onSaved: (driver: Driver) => void }) {
  const [values, setValues] = useState<DriverProfileValues>(() => driverProfileFromDriver(driver));
  const trucks = usePickerList<Truck>("trucks");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await apiClient.update<Driver>("drivers", driver.id, driverProfileToPayload(values));
      onSaved(updated);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <DriverProfileFields values={values} onChange={setValues} trucks={trucks} />

      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">Saved.</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
