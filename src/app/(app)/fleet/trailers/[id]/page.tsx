"use client";

// UI/UX upgrade: the trailer's own screen - photo, edit form, and its
// documents. Same shape as the truck and driver detail screens.

import { use, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { apiClient, ApiClientError } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { ListLoading, ListError } from "@/components/ListStates";
import { EntityPhoto, PhotoUpload } from "@/components/EntityPhoto";
import TrailerFields, {
  trailerFromTrailer,
  trailerToPayload,
  type TrailerValues,
} from "@/components/TrailerFields";
import { usePageTitle } from "@/lib/use-page-title";
import type { Trailer } from "@/types/entities";

export default function TrailerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Trailer");
  const [trailer, setTrailer] = useState<Trailer | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<Trailer>("trailers", id)
      .then((row) => {
        if (!cancelled) setTrailer(row);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load this trailer. Check the connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div>
        <PageHeader title="Trailer" purpose="One trailer, in full." />
        <ListError message={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (!trailer) {
    return (
      <div>
        <PageHeader title="Trailer" purpose="One trailer, in full." />
        <ListLoading />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={`Trailer ${trailer.unit_number}`}
        purpose={
          trailer.trailer_type
            ? `A ${trailer.trailer_type.toLowerCase()} — its photo, details, and records in one place.`
            : "Its photo, details, and records in one place."
        }
      />

      <EntityPhoto
        entityType="trailer"
        entityId={trailer.id}
        photoDocumentId={trailer.photo_document_id}
        size="hero"
        alt={`Photo of trailer ${trailer.unit_number}`}
      />
      <PhotoUpload
        entityType="trailer"
        entityId={trailer.id}
        resource="trailers"
        hasPhoto={trailer.photo_document_id != null}
        onUploaded={(documentId) => setTrailer({ ...trailer, photo_document_id: documentId })}
      />

      <section aria-label="Related records">
        <h2>This trailer&apos;s records</h2>
        <ul>
          <li>
            <Link href={`/more/documents?related_entity_type=trailer&related_entity_id=${trailer.id}`}>
              Documents — registration, inspections, photos
            </Link>
          </li>
          <li>
            <Link href="/fleet/equipment-checklist">Equipment on board</Link>
          </li>
          <li>
            <Link href="/fleet/maintenance-schedule">Maintenance schedule</Link>
          </li>
        </ul>
      </section>

      <TrailerEditForm key={trailer.id} trailer={trailer} onSaved={setTrailer} />
    </div>
  );
}

function TrailerEditForm({ trailer, onSaved }: { trailer: Trailer; onSaved: (trailer: Trailer) => void }) {
  const [values, setValues] = useState<TrailerValues>(() => trailerFromTrailer(trailer));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await apiClient.update<Trailer>("trailers", trailer.id, trailerToPayload(values));
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
      <TrailerFields values={values} onChange={setValues} />

      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">Saved.</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
