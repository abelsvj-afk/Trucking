"use client";

// UI/UX upgrade: the truck's own screen. Before this, a truck was a
// line in a list with no way to see it, photograph it, or fix its
// details. Here: the photo (upload/replace, riding the documents
// pipeline), the full identity + profile edit form, and the way
// through to everything that hangs off this truck - its documents,
// its maintenance history, its equipment.

import {use, useEffect, useState} from "react";
import Link from "next/link";
import {apiClient} from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import Sheet from "@/components/Sheet";
import TruckEditForm from "@/components/edit/TruckEditForm";
import {ListLoading, ListError} from "@/components/ListStates";
import {EntityPhoto, PhotoUpload} from "@/components/EntityPhoto";
import TruckProfileFields, {
  truckProfileFromTruck,
  truckProfileToPayload,
  type TruckProfileValues,
} from "@/components/TruckProfileFields";
import TruckIdentityFields, {
  truckIdentityFromTruck,
  truckIdentityToPayload,
  type TruckIdentityValues,
} from "@/components/TruckIdentityFields";
import {usePageTitle} from "@/lib/use-page-title";
import {DeleteRecordButton} from "@/components/RecordLifecycle";
import {truckTypeLabel} from "@/lib/fleet-display";
import type {Truck, VehicleDefect} from "@/types/entities";
import {formatDate} from "@/lib/time";

export default function TruckDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Truck");
  const [truck, setTruck] = useState<Truck | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openDefects, setOpenDefects] = useState<VehicleDefect[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<Truck>("trucks", id)
      .then((row) => {
        if (!cancelled) setTruck(row);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this truck. Check the connection and try again.");
      });
    // Open tracked defects (Image Intelligence §5.5): a line on
    // the truck's own page. Best-effort - before migration 00046
    // the resource doesn't exist and the section simply stays off.
    apiClient
      .list<VehicleDefect>("vehicle-defects", { truck_id: id })
      .then((result) => {
        if (!cancelled) {
          setOpenDefects(
            result.data.filter((d) => d.status === "open" || d.status === "acknowledged"),
          );
        }
      })
      .catch(() => {
        // Defect tracking not live yet - no section, no error.
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div>
        <PageHeader title="Truck" purpose="One truck, in full." />
        <ListError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!truck) {
    return (
      <div>
        <PageHeader title="Truck" purpose="One truck, in full." />
        <ListLoading />
      </div>
    );
  }

  const type = truckTypeLabel(truck.truck_type);

  return (
    <div>
      <PageHeader
        title={`Truck ${truck.unit_number}`}
        purpose={type ? `A ${type.toLowerCase()} — its photo, details, and history in one place.` : "Its photo, details, and history in one place."}
      
        action={
          <button type="button" className="page-action" onClick={() => setEditOpen(true)}>
            Edit
          </button>
        }
      />

      <EntityPhoto
        entityType="truck"
        entityId={truck.id}
        photoDocumentId={truck.photo_document_id}
        size="hero"
        alt={`Photo of truck ${truck.unit_number}`}
      />
      <PhotoUpload
        entityType="truck"
        entityId={truck.id}
        resource="trucks"
        hasPhoto={truck.photo_document_id != null}
        onUploaded={(documentId) => setTruck({ ...truck, photo_document_id: documentId })}
      />

      {openDefects.length > 0 && (
        <section aria-label="Open defects">
          <h2>Open defects ({openDefects.length})</h2>
          <ul>
            {openDefects.map((defect) => (
              <li key={defect.id}>
                {defect.description} — {defect.status}, first noted{" "}
                {formatDate(defect.created_at, "America/New_York")}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Related records">
        <h2>This truck&apos;s records</h2>
        <ul>
          <li>
            <Link href={`/more/documents?related_entity_type=truck&related_entity_id=${truck.id}`}>
              Documents — permits, registrations, photos
            </Link>
          </li>
          <li>
            <Link href={`/fleet/maintenance-events?truck_id=${truck.id}`}>Maintenance history</Link>
          </li>
          <li>
            <Link href={`/fleet/equipment-checklist?truck_id=${truck.id}`}>Equipment on board</Link>
          </li>
          <li>
            <Link href="/fleet/truck-profile">Route profile (size, speed, cab)</Link>
          </li>
        </ul>
      </section>

      {editOpen && (
          <Sheet title="Edit truck" onClose={() => setEditOpen(false)}>
            <TruckEditForm key={truck.id} truck={truck} onSaved={(updated) => { setTruck(updated); setEditOpen(false); }} />
          </Sheet>
        )}

      <section aria-label="Delete this record">
        <h2>Delete this record</h2>
        <DeleteRecordButton
          resource="trucks"
          id={truck.id}
          recordName={`Truck ${truck.unit_number}`}
          listHref="/fleet/trucks"
          listLabel="trucks"
        />
      </section>
    </div>
  );
}
