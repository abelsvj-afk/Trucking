"use client";

// UI/UX upgrade: the truck's own screen. Before this, a truck was a
// line in a list with no way to see it, photograph it, or fix its
// details. Here: the photo (upload/replace, riding the documents
// pipeline), the full identity + profile edit form, and the way
// through to everything that hangs off this truck - its documents,
// its maintenance history, its equipment.

import { use, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { EntityPhoto, PhotoUpload } from "@/components/EntityPhoto";
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
import { usePageTitle } from "@/lib/use-page-title";
import { truckTypeLabel } from "@/lib/fleet-display";
import type { Truck } from "@/types/entities";

export default function TruckDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Truck");
  const [truck, setTruck] = useState<Truck | null>(null);
  const [error, setError] = useState<string | null>(null);

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

      <section aria-label="Related records">
        <h2>This truck&apos;s records</h2>
        <ul>
          <li>
            <Link href={`/more/documents?related_entity_type=truck&related_entity_id=${truck.id}`}>
              Documents — permits, registrations, photos
            </Link>
          </li>
          <li>
            <Link href="/fleet/maintenance-events">Maintenance history</Link>
          </li>
          <li>
            <Link href="/fleet/equipment-checklist">Equipment on board</Link>
          </li>
          <li>
            <Link href="/fleet/truck-profile">Route profile (size, speed, cab)</Link>
          </li>
        </ul>
      </section>

      <TruckEditForm key={truck.id} truck={truck} onSaved={setTruck} />
    </div>
  );
}

function TruckEditForm({ truck, onSaved }: { truck: Truck; onSaved: (truck: Truck) => void }) {
  const [identity, setIdentity] = useState<TruckIdentityValues>(() => truckIdentityFromTruck(truck));
  const [profile, setProfile] = useState<TruckProfileValues>(() => truckProfileFromTruck(truck));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await apiClient.update<Truck>("trucks", truck.id, {
        ...truckIdentityToPayload(identity),
        ...truckProfileToPayload(profile),
      });
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
      <TruckIdentityFields values={identity} onChange={setIdentity} />
      <TruckProfileFields values={profile} onChange={setProfile} />

      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">Saved.</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
