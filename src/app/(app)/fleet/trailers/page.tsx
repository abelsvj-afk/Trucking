"use client";

// Task 3.2 (TASKS.md), UI/UX upgrade: purpose header, teaching empty
// state, photo thumbnails, and rows that link to the trailer detail
// screen - same treatment as the trucks list.

import Link from "next/link";
import { useApiList } from "@/lib/use-api-list";
import { ListLoading, TeachingEmpty, ListError } from "@/components/ListStates";
import PageHeader from "@/components/PageHeader";
import { EntityPhoto } from "@/components/EntityPhoto";
import { usePageTitle } from "@/lib/use-page-title";
import type { Trailer } from "@/types/entities";

const STATUS_BADGES: Record<Trailer["status"], string> = {
  active: "ok",
  maintenance: "unknown",
  inactive: "paused",
};

export default function TrailersListPage() {
  usePageTitle("Trailers");
  const { state, retry } = useApiList<Trailer>("trailers");

  return (
    <div>
      <PageHeader
        title="Trailers"
        purpose="Every trailer you pull — its type, its photo, and its inspection and maintenance history."
        action={
          <Link href="/fleet/trailers/new" className="page-action">
            Add trailer
          </Link>
        }
      />

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={retry} />}
      {state.status === "loaded" && state.result.data.length === 0 && (
        <TeachingEmpty
          title="No trailers yet"
          message="Add the trailer you're pulling. Its type and photo live here, and pre-trip inspections and maintenance hang off the trailer itself — so a defect history is the trailer's, not lost when you swap trucks."
          action={<Link href="/fleet/trailers/new">Add your first trailer</Link>}
        />
      )}
      {state.status === "loaded" && state.result.data.length > 0 && (
        <ul>
          {state.result.data.map((trailer) => (
            <li key={trailer.id}>
              <Link href={`/fleet/trailers/${trailer.id}`} className="row-with-photo">
                <EntityPhoto
                  entityType="trailer"
                  entityId={trailer.id}
                  photoDocumentId={trailer.photo_document_id}
                  size="thumb"
                  alt={`Photo of trailer ${trailer.unit_number}`}
                />
                <span className="row-text">
                  <span className="row-title">
                    <strong data-status={STATUS_BADGES[trailer.status]}>{trailer.status}</strong>
                    Trailer {trailer.unit_number}
                    {trailer.trailer_type ? ` — ${trailer.trailer_type}` : ""}
                  </span>
                  <span className="row-sub">
                    {trailer.vin ? `VIN ${trailer.vin}` : "Tap to complete this trailer's profile"}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
