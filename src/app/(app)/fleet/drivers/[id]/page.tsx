"use client";

// UI/UX upgrade: the driver's own screen - photo, the complete
// profile as an edit form, and the way through to their documents.
// Mirrors the truck detail screen's shape on purpose: one pattern
// for every fleet record.

import {use, useEffect, useState} from "react";
import Link from "next/link";
import {apiClient} from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import Sheet from "@/components/Sheet";
import DriverEditForm from "@/components/edit/DriverEditForm";
import {ListLoading, ListError} from "@/components/ListStates";
import {EntityPhoto, PhotoUpload} from "@/components/EntityPhoto";
import DriverProfileFields, {
  driverProfileFromDriver,
  driverProfileToPayload,
  type DriverProfileValues,
} from "@/components/DriverProfileFields";
import {usePageTitle} from "@/lib/use-page-title";
import {DeleteRecordButton} from "@/components/RecordLifecycle";
import {driverRoleLabel} from "@/lib/fleet-display";
import type {Driver} from "@/types/entities";

export default function DriverDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Driver");
  const [driver, setDriver] = useState<Driver | null>(null);
  const [editOpen, setEditOpen] = useState(false);
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
      
        action={
          <button type="button" className="page-action" onClick={() => setEditOpen(true)}>
            Edit
          </button>
        }
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

      {editOpen && (
          <Sheet title="Edit driver" onClose={() => setEditOpen(false)}>
            <DriverEditForm key={driver.id} driver={driver} onSaved={(updated) => { setDriver(updated); setEditOpen(false); }} />
          </Sheet>
        )}

      <section aria-label="Delete this record">
        <h2>Delete this record</h2>
        <DeleteRecordButton
          resource="drivers"
          id={driver.id}
          recordName={driver.name}
          listHref="/fleet/drivers"
          listLabel="drivers"
        />
      </section>
    </div>
  );
}
